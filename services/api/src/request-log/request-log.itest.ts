import "reflect-metadata";

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

describe("the API request log", () => {
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

  /** The producer is fire-and-forget, so the row arrives after the response. Poll to a
   *  deadline for what must arrive -- a flat sleep before an assertion is a bet that the
   *  lane is idle, and this project has one red in twenty runs to show for that bet. */
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
  });

  afterAll(async () => {
    await app?.close();
    for (const e of [env, limited]) {
      if (e !== undefined) {
        await ch(`DELETE FROM relay_analytics.api_requests
                   WHERE environment_id = toUUID('${e.id}')`);
      }
    }
  });

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
  });

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
  });

  it("records an unmatched route with no endpoint, and says why", async () => {
    const missing = await call("/v1/does-not-exist");
    expect(missing.status).toBe(404);
    const row = await settle(missing.id);
    expect(row?.refused_at).toBe("unmatched");
    // absent, not '' -- a 404 matched nothing and a route named "" does not exist
    expect(row?.endpoint).toBe("~absent");
  });

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
  });
});
