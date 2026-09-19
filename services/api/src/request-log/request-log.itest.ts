import "reflect-metadata";

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { createApiKey, createEnvironment, setEnvironmentLimits } from "../db/repository";

// The request log, end to end: a request is served, a record reaches the stream, the
// ingester writes it, and the row says which layer decided the response.
//
// EVERY ASSERTION HERE IS SCOPED TO THIS SUITE'S OWN ENVIRONMENTS. The api lane runs two
// files at a time and a whole-table count would be a neighbour's problem -- eight of those
// were found one failure at a time across six runs before `check-lane-scope.py` existed.

const CH = `http://localhost:${process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123"}/`;
const CH_AUTH = "Basic " + Buffer.from("relay:relay").toString("base64");
const ch = async (body: string): Promise<string> =>
  fetch(CH, { method: "POST", headers: { Authorization: CH_AUTH }, body }).then((r) => r.text());

// AND THE SUITE STARTS THE INGESTER ITSELF (chapter 4.9, FR-003).
//
// These five tests have been red on any machine with no ingester since chapter 4.4 — five of
// the six failures that made `pnpm test:integration` red on every run, so **a planted drift
// in the reconciler could not change the gate's colour: it was already that colour.**
//
// THE OBVIOUS FIX WAS A SERVICE IN `compose.yaml` AND IT IS THE WRONG ONE, for two reasons
// that only appear once you open the file. `services/ingester` has **no Dockerfile**, so it is
// not a service definition but a new image; and `api`, `gateway` and `dispatcher` all carry
// `profiles: ["services"]`, so `docker compose up -d` starts the stores and nothing else —
// an ingester added beside them would not be running when the lane runs, and one added to the
// default profile would drain the analytics stream on every developer's machine forever,
// changing the opening state of every analytical suite in the repository.
//
// A CHILD PROCESS FOR THE LIFETIME OF THE SUITE THAT NEEDS IT. `consumer.itest.ts` and
// `outbox.itest.ts` already spawn a Node child for the same reason, and the ingester is a
// plain Node process. It drains while these five tests run and is killed afterwards, so the
// lane-wide side effect is bounded by the suite rather than by the machine's uptime.
//
// WHAT IT DRAINS IS REPORTED RATHER THAN ASSERTED. A durable consumer drains the whole
// stream, not this suite's share of it, so the figure includes whatever the file running
// beside it produced. That is what a real deployment does; the number is printed so nobody
// has to guess at it.
const INGESTER = join(__dirname, "..", "..", "..", "..", "services", "ingester", "dist", "main.js");

describe("the API request log", () => {
  let ingester: ChildProcess | undefined;
  const drained = { batches: 0, written: 0, requests: 0 };
  let app: INestApplication;
  let url: string;
  let db: Db;
  let env: { id: string };
  let key: { credential: string };
  let limited: { id: string };
  let limitedKey: { credential: string };

  const rowsFor = async (environmentId: string): Promise<number> =>
    Number(
      await ch(`SELECT count() FROM relay_analytics.api_requests FINAL
                 WHERE environment_id = toUUID('${environmentId}')`),
    );

  const rowFor = async (requestId: string): Promise<Record<string, string> | null> => {
    const line = (
      await ch(`SELECT refused_at, ifNull(endpoint,'~absent'), ifNull(limited_operation,'~absent'),
                       principal_kind, toString(status)
                  FROM relay_analytics.api_requests FINAL
                 WHERE request_id = toUUID('${requestId}') FORMAT TSV`)
    ).trim();
    if (line === "") return null;
    const [refused_at, endpoint, limited_operation, principal_kind, status] = line.split("\t");
    return { refused_at: refused_at!, endpoint: endpoint!, limited_operation: limited_operation!,
             principal_kind: principal_kind!, status: status! };
  };

  /** The response's own id, so an assertion names the request it made rather than the most
   *  recent row in the table. */
  const call = async (path: string, credential?: string): Promise<{ status: number; id: string }> => {
    const res = await fetch(`${url}${path}`, {
      headers: credential === undefined ? {} : { authorization: `Bearer ${credential}` },
    });
    return { status: res.status, id: res.headers.get("x-request-id") ?? "" };
  };

  /** The producer is fire-and-forget, so the row arrives after the response.
   * Poll to a deadline for what must arrive. A flat sleep before an assertion is a bet
   *  that the lane is idle, and this project has one red in twenty runs to show for that
   *  bet.
   *
   *  AND THE BUDGET HAS TO BE BIGGER THAN THE DEADLINE, which it was not until chapter
   *  4.10. Vitest's default per-test timeout is 5,000 ms and this lane's config sets none,
   *  so a 20-second deadline was killed four times before it could fire: the `return null`
   *  below was unreachable and `expect(...).not.toBeNull()` was an assertion that could
   *  never fail. Each test carries `}, 60_000)` now (056-4). */
  const settle = async (requestId: string, timeoutMs = 20_000): Promise<Record<string, string> | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await rowFor(requestId);
      if (row !== null) return row;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  beforeAll(async () => {
    // REFUSING IS THE RIGHT ERROR. A suite that skipped itself here would be green on a
    // machine that cannot run it, which is the shape this chapter spent a phase finding in
    // the isolation gauntlet — three attacks that returned at their first line and reported
    // a tick. `test:integration` dependsOn `["^build", "build"]`, and the ingester is not a
    // dependency of the api, so its `dist` is the one this lane cannot assume.
    if (!existsSync(INGESTER)) {
      throw new Error(`${INGESTER} does not exist; run \`pnpm build\` before this lane`);
    }
    ingester = spawn("node", [INGESTER], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    ingester.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.includes("ingester.batch")) continue;
        try {
          const batch = JSON.parse(line) as { written?: number; requests?: number };
          drained.batches += 1;
          drained.written += batch.written ?? 0;
          drained.requests += batch.requests ?? 0;
        } catch {
          // a partial line across two chunks; the next one carries the whole record
        }
      }
    });

    db = createDb(createPool());
    env = await createEnvironment(db, { name: "request-log-itest" });
    key = await createApiKey(db, { environmentId: env.id });

    limited = await createEnvironment(db, { name: "request-log-itest-limited" });
    limitedKey = await createApiKey(db, { environmentId: limited.id });
    // FR-RTL-04's per-environment override, so the limiter is reachable in two requests
    // instead of six hundred.
    await setEnvironmentLimits(db, { environmentId: limited.id, restPerMinute: 1 });

    app = (await Test.createTestingModule({ imports: [AppModule] }).compile())
      .createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    ingester?.kill("SIGTERM");
    process.stdout.write(
      `request-log.itest: the ingester drained ${drained.batches} batches, ` +
        `${drained.written} records, ${drained.requests} of them requests\n`,
    );
    await app?.close();
    for (const e of [env, limited]) {
      if (e !== undefined) {
        await ch(`DELETE FROM relay_analytics.api_requests
                   WHERE environment_id = toUUID('${e.id}')`);
      }
    }
  }, 60_000);

  it("records a served request, against a non-zero floor", async () => {
    const before = await rowsFor(env.id);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { status, id } = await call("/v1/webhooks", key.credential);
      expect(status).toBe(200);
      ids.push(id);
    }
    for (const id of ids) expect(await settle(id)).not.toBeNull();

    const after = await rowsFor(env.id);
    // FIVE REQUESTS, FIVE ROWS, AND THE FLOOR IS THE POINT. 047's T023 compared three counts
    // over an empty table and called them equal at 0, 0, 0 -- a three-way equality with no
    // floor is satisfied by nothing at all.
    expect(ids).toHaveLength(5);
    expect(after - before).toBe(5);
  }, 60_000);

  it("tells a guard refusal from a handler response at the same status", async () => {
    const guarded = await call("/v1/webhooks", "not-a-real-credential");
    expect(guarded.status).toBe(401);
    const guardRow = await settle(guarded.id);
    expect(guardRow?.refused_at).toBe("guard");
    // the router RAN, so the endpoint is there -- a guard refusal is attributable
    expect(guardRow?.endpoint).not.toBe("~absent");

    const served = await call("/v1/webhooks", key.credential);
    expect(served.status).toBe(200);
    expect((await settle(served.id))?.refused_at).toBe("handler");
  }, 60_000);

  it("records an unmatched route with no endpoint, and says why", async () => {
    const missing = await call("/v1/does-not-exist");
    expect(missing.status).toBe(404);
    const row = await settle(missing.id);
    expect(row?.refused_at).toBe("unmatched");
    // absent, not '' -- a 404 matched nothing and a route named "" does not exist
    expect(row?.endpoint).toBe("~absent");
  }, 60_000);

  // FR-010, and the verification method is T rather than D. Constitution I is the one
  // principle this project does not accept a demonstration for: a screenshot of the right
  // rows is not a claim about every query, and the clause the chapter leans on -- that a
  // record with no tenant is not tenant data -- is only true if no tenant-scoped read can
  // reach one.
  it("returns this tenant's rows and ZERO tenantless ones", async () => {
    const served = await call("/v1/webhooks", key.credential);
    expect(served.status).toBe(200);
    expect(await settle(served.id)).not.toBeNull();

    const anonymous = await call("/v1/webhooks");
    expect(anonymous.status).toBe(401);
    expect(await settle(anonymous.id)).not.toBeNull();

    // The tenant-scoped read: exactly the shape a customer-facing query surface would use.
    const scoped = (
      await ch(`SELECT count(), countIf(environment_id IS NULL)
                  FROM relay_analytics.api_requests FINAL
                 WHERE environment_id = toUUID('${env.id}') FORMAT TSV`)
    ).trim().split("\t").map(Number);

    // A NON-ZERO FLOOR ON THE FIRST NUMBER. Without it, "no tenantless rows" is satisfied by
    // a query that returned nothing at all -- 047's T023 compared three counts over an empty
    // table and called them equal at 0, 0, 0.
    expect(scoped[0]).toBeGreaterThan(0);
    expect(scoped[1]).toBe(0);

    // And the tenantless row that was just written is genuinely there, under no tenant --
    // so the zero above is isolation rather than absence.
    const orphans = Number(
      await ch(`SELECT count() FROM relay_analytics.api_requests FINAL
                 WHERE environment_id IS NULL AND request_id = toUUID('${anonymous.id}')`),
    );
    expect(orphans).toBe(1);

    // A foreign tenant sees neither.
    const foreign = Number(
      await ch(`SELECT count() FROM relay_analytics.api_requests FINAL
                 WHERE environment_id = toUUID('${limited.id}')
                   AND request_id IN (toUUID('${served.id}'), toUUID('${anonymous.id}'))`),
    );
    expect(foreign).toBe(0);
  }, 60_000);

  it("records the rate limiter's 429 at all, and names the operation it refused on", async () => {
    // Position 2 is what makes this possible: RateLimitMiddleware refuses with
    // `res.end(); return;` and never calls next(), so a producer registered after it would
    // never run for this request.
    let refused: { status: number; id: string } | undefined;
    for (let i = 0; i < 6 && refused === undefined; i++) {
      const r = await call("/v1/webhooks", limitedKey.credential);
      if (r.status === 429) refused = r;
    }
    expect(refused, "the limiter never refused; the override did not take").toBeDefined();

    const row = await settle(refused!.id);
    expect(row?.refused_at).toBe("middleware");
    // `rest`, not a route template: the limiter's whole route knowledge is three-valued.
    expect(row?.limited_operation).toBe("rest");
    expect(row?.status).toBe("429");
  }, 60_000);
});
