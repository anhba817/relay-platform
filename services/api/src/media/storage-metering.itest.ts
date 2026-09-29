import "reflect-metadata";

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { createApiKey, createEnvironment } from "../db/repository";
import { ensureBucket, storeConfig } from "./store";

// FR-MED-12's DAILY FIGURE, END TO END (US1).
//
// **THIS SUITE SPAWNS THE INGESTER, WHICH IS NOT A COMPOSE SERVICE** (4.9 — it has no
// Dockerfile). `media.itest.ts` does the same and 050-8 is still open: *"two test files
// starting a process is not a deployment."* This chapter leans on it harder than any
// before, because every figure it publishes is on the far side of that process.
const INGESTER = join(__dirname, "..", "..", "..", "..", "services", "ingester", "dist", "main.js");
const CLICKHOUSE = process.env.RELAY_CLICKHOUSE_URL ?? "http://localhost:8123";

async function ch(query: string): Promise<string> {
  const res = await fetch(CLICKHOUSE, {
    method: "POST",
    headers: { "x-clickhouse-user": "relay", "x-clickhouse-key": "relay" },
    body: query,
  });
  if (!res.ok) throw new Error(`clickhouse: ${res.status} ${await res.text()}`);
  return res.text();
}

describe("a tenant's stored bytes have a daily history", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let ingester: ChildProcess;
  let env: { id: string };
  let otherEnv: { id: string };
  let key: { credential: string };
  let otherKey: { credential: string };
  const store = storeConfig();

  /** The worker's own credential, set before the app is built — the same shape
   *  `media-verdict.itest.ts` uses. Without it every verdict is a 401 and the producer
   *  under test is never reached, which is 4.9's finding and 4.14 met it twice. */
  const WORKER = "rk_svc_storage_metering_itest_0123456789ab";

  const verdict = (id: string, body: unknown) =>
    fetch(`${url}/internal/media/${id}/verdict`, {
      method: "POST",
      headers: { authorization: `Bearer ${WORKER}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const slot = (credential: string, bytes: number, mime = "image/png") =>
    fetch(`${url}/v1/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ filename: "m.png", mime_type: mime, bytes }),
    });

  /** The tenant's events, summed. Polls, because the record crosses a broker and a
   *  process — **arrival is a condition and a flat sleep is a bet that the lane is
   *  idle** (045). A quiet window would belong after this, never instead of it. */
  const deltaFor = async (environmentId: string, expected: number): Promise<number> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const seen = Number(
        (
          await ch(`SELECT coalesce(sum(bytes_delta), 0) FROM relay_analytics.media_events
                     WHERE environment_id = toUUID('${environmentId}')`)
        ).trim(),
      );
      if (seen === expected || Date.now() > deadline) return seen;
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  const eventsFor = async (environmentId: string): Promise<string> =>
    (
      await ch(`SELECT event, kind, bytes_delta FROM relay_analytics.media_events
                 WHERE environment_id = toUUID('${environmentId}')
                 ORDER BY ts, event FORMAT TSV`)
    ).trim();

  beforeAll(async () => {
    if (!existsSync(INGESTER)) {
      throw new Error(`${INGESTER} does not exist; run \`pnpm build\` before this lane`);
    }
    process.env["RELAY_INTERNAL_CREDENTIAL_WORKER"] = WORKER;
    ingester = spawn("node", [INGESTER], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    await ensureBucket(store);

    db = createDb(createPool());
    env = await createEnvironment(db, { name: "storage-metering-itest" });
    key = await createApiKey(db, { environmentId: env.id });
    otherEnv = await createEnvironment(db, { name: "storage-metering-itest-other" });
    otherKey = await createApiKey(db, { environmentId: otherEnv.id });

    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(
      { logger: false },
    );
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    ingester?.kill("SIGTERM");
  });

  it("moves the day's delta by exactly the bytes the quota counts", async () => {
    const res = await slot(key.credential, 447_377);
    expect(res.status).toBe(201);
    // FR-002: the quota sums `declared_bytes` where `state <> 'rejected'`, so a `pending`
    // object is ALREADY charged. The meter agrees because it carries the same number, not
    // because the two were reconciled.
    expect(await deltaFor(env.id, 447_377)).toBe(447_377);
    expect(await eventsFor(env.id)).toBe("reserved\timage\t447377");
  }, 60_000);

  it("keeps one tenant's bytes out of another's figure", async () => {
    expect((await slot(otherKey.credential, 1_000)).status).toBe(201);
    // The other tenant's own figure is its own; this one is unchanged by it.
    expect(await deltaFor(otherEnv.id, 1_000)).toBe(1_000);
    expect(await deltaFor(env.id, 447_377)).toBe(447_377);
  }, 60_000);

  it("answers zero for a tenant with no media, rather than nothing", async () => {
    const quiet = await createEnvironment(db, { name: "storage-metering-itest-quiet" });
    // A caller must not have to tell "no change" from "no tenant". `sum()` over an empty
    // set answers 0 rather than an empty result — the same fact `storedMessages` records,
    // which is why neither reader carries an empty-result guard.
    expect(await deltaFor(quiet.id, 0)).toBe(0);
  }, 60_000);

  it("records the kind, so FR-009's counts have something to group by", async () => {
    const audio = await createEnvironment(db, { name: "storage-metering-itest-audio" });
    const audioKey = await createApiKey(db, { environmentId: audio.id });
    expect((await slot(audioKey.credential, 2_048, "audio/mpeg")).status).toBe(201);
    expect(await deltaFor(audio.id, 2_048)).toBe(2_048);
    expect(await eventsFor(audio.id)).toBe("reserved\taudio\t2048");
  }, 60_000);

  it("takes the bytes back on a rejection, and emits nothing on the duplicate", async () => {
    const rejecting = await createEnvironment(db, { name: "storage-metering-itest-reject" });
    const rejectingKey = await createApiKey(db, { environmentId: rejecting.id });
    const created = (await (await slot(rejectingKey.credential, 9_000)).json()) as {
      media_id: string;
    };
    expect(await deltaFor(rejecting.id, 9_000)).toBe(9_000);

    const body = { verdict: "rejected", reason: "declaration_mismatch", verified_bytes: 10 };
    expect((await verdict(created.media_id, body)).status).toBe(200);
    // The quota counts `state <> 'rejected'`, so a refused object stops being charged and
    // the meter says the same by carrying the negation rather than by being told.
    expect(await deltaFor(rejecting.id, 0)).toBe(0);
    expect(await eventsFor(rejecting.id)).toBe(
      "reserved\timage\t9000\nrejected\timage\t-9000",
    );

    // FR-005, ASSERTED BY ISSUING THE DUPLICATE rather than reasoning that the
    // compare-and-set makes it impossible. 4.15's idempotence class was caught that way,
    // and 4.14's five accounting tests were each protecting against the same reasoning.
    //
    // **A SECOND VERDICT ON A REJECTED OBJECT IS A 422, NOT A 200 WITH `applied: false`**
    // — the route refuses it *"because its bytes are gone"*, which `media-verdict.itest.ts`
    // tests by name. The first draft of this test expected the `ready` path's answer and
    // got `expected undefined to be false`. Either way no second delta may be emitted,
    // and that is what the assertion below is for; the status is how the platform says so.
    const again = await verdict(created.media_id, body);
    expect(again.status).toBe(422);
    // Give the second publish the time it would have needed, then assert the absence.
    // A quiet window AFTER an arrival wait is the only honest form (045).
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await eventsFor(rejecting.id)).toBe(
      "reserved\timage\t9000\nrejected\timage\t-9000",
    );
  }, 90_000);
});
