import "reflect-metadata";

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { createApiKey, createEnvironment, Repository } from "../db/repository";
import { ensureBucket, storeConfig } from "./store";

// FR-MED-12's DAILY FIGURE, END TO END (US1).
//
// **THIS SUITE SPAWNS THE INGESTER, WHICH IS NOT A COMPOSE SERVICE** (4.9 — it has no
// Dockerfile). `media.itest.ts` does the same and 050-8 is still open: *"two test files
// starting a process is not a deployment."* This chapter leans on it harder than any
// before, because every figure it publishes is on the far side of that process.
const INGESTER = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "services",
  "ingester",
  "dist",
  "main.js",
);
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
      headers: {
        authorization: `Bearer ${WORKER}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const slot = (credential: string, bytes: number, mime = "image/png") =>
    fetch(`${url}/v1/media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ filename: "m.png", mime_type: mime, bytes }),
    });

  /** The tenant's events, summed. Polls, because the record crosses a broker and a
   *  process — **arrival is a condition and a flat sleep is a bet that the lane is
   *  idle** (045). A quiet window would belong after this, never instead of it. */
  const deltaFor = async (
    environmentId: string,
    expected: number,
  ): Promise<number> => {
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

  /** The ROLLUP's answer for a tenant, not the raw table's — `sumMap` and `sum` over
   *  `daily_usage_billing`, which is the table DR-10 says billing opens.
   *
   *  **AGGREGATED RATHER THAN SELECTED, AND `SummingMergeTree` IS WHY.** Reading the
   *  column directly returns one row per unmerged part, so the answer depends on whether
   *  a merge has happened — 4.9 measured a bare `count()` on this engine giving 15 and
   *  then 9 with nothing deleted in between. The invariant is stated over the sum, which
   *  holds in every state. */
  const rollupFor = async (
    environmentId: string,
  ): Promise<{ byKind: string; bytes: number }> => {
    const tsv = (
      await ch(`SELECT sumMap(uploads_by_kind), sum(stored_bytes_delta)
                  FROM relay_analytics.daily_usage_billing
                 WHERE environment_id = toUUID('${environmentId}')
                 FORMAT TSV`)
    ).trim();
    const [byKind = "", bytes = "0"] = tsv.split("\t");
    return { byKind, bytes: Number(bytes) };
  };

  /** Poll the ROLLUP until it says what it is going to say. The record crosses a broker,
   *  a process, an insert and a materialised view; only the last of those is synchronous
   *  with the insert.
   *
   *  **IT WAITS ON BOTH COLUMNS, BECAUSE WAITING ON ONE IS WAITING ON THE WRONG THING.**
   *  The first version polled `uploads_by_kind` alone and the FR-010 test below is
   *  precisely the case where that column does NOT move: it returned on the first read,
   *  before the rendition's delta had crossed the broker, and reported
   *  `expected 50000 to be 57000` — a red that reads exactly like the feature being
   *  broken. *Arrival is a condition* (045), and the condition has to be the thing the
   *  test is about. */
  const rollupSettles = async (
    environmentId: string,
    want: { byKind: string; bytes: number },
  ): Promise<{ byKind: string; bytes: number }> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const seen = await rollupFor(environmentId);
      if (
        (seen.byKind === want.byKind && seen.bytes === want.bytes) ||
        Date.now() > deadline
      ) {
        return seen;
      }
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
      throw new Error(
        `${INGESTER} does not exist; run \`pnpm build\` before this lane`,
      );
    }
    process.env["RELAY_INTERNAL_CREDENTIAL_WORKER"] = WORKER;
    ingester = spawn("node", [INGESTER], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await ensureBucket(store);

    db = createDb(createPool());
    env = await createEnvironment(db, { name: "storage-metering-itest" });
    key = await createApiKey(db, { environmentId: env.id });
    otherEnv = await createEnvironment(db, {
      name: "storage-metering-itest-other",
    });
    otherKey = await createApiKey(db, { environmentId: otherEnv.id });

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
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
    const quiet = await createEnvironment(db, {
      name: "storage-metering-itest-quiet",
    });
    // A caller must not have to tell "no change" from "no tenant". `sum()` over an empty
    // set answers 0 rather than an empty result — the same fact `storedMessages` records,
    // which is why neither reader carries an empty-result guard.
    expect(await deltaFor(quiet.id, 0)).toBe(0);
  }, 60_000);

  it("records the kind, so FR-009's counts have something to group by", async () => {
    const audio = await createEnvironment(db, {
      name: "storage-metering-itest-audio",
    });
    const audioKey = await createApiKey(db, { environmentId: audio.id });
    expect((await slot(audioKey.credential, 2_048, "audio/mpeg")).status).toBe(
      201,
    );
    expect(await deltaFor(audio.id, 2_048)).toBe(2_048);
    expect(await eventsFor(audio.id)).toBe("reserved\taudio\t2048");
  }, 60_000);

  it("takes the bytes back on a rejection, and emits nothing on the duplicate", async () => {
    const rejecting = await createEnvironment(db, {
      name: "storage-metering-itest-reject",
    });
    const rejectingKey = await createApiKey(db, {
      environmentId: rejecting.id,
    });
    const created = (await (
      await slot(rejectingKey.credential, 9_000)
    ).json()) as {
      media_id: string;
    };
    expect(await deltaFor(rejecting.id, 9_000)).toBe(9_000);

    const body = {
      verdict: "rejected",
      reason: "declaration_mismatch",
      verified_bytes: 10,
    };
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

  it("emits nothing for an object whose declared type is no longer in the vocabulary", async () => {
    // **THE ARM THE COVERAGE PIN FOUND, AND IT IS REACHABLE — just not through the slot
    // route.** `kindOf` answers `null` for a type outside `ALLOWED_TYPES` and the slot
    // route refuses those, so the first version of `meterStorage` recorded the arm as
    // unreachable and left it untested: `media.controller.ts` measured 91.89% statements
    // against a pin of 92 and the missing statements were that `return`.
    //
    // It is reachable the moment `ALLOWED_TYPES` changes, which is a deploy and not a
    // hypothetical: a row written under the old vocabulary outlives it, and its verdict
    // still arrives. The object is planted through `reserveMediaSlot` — the repository
    // does not validate the type, the SERVICE does — which is exactly the shape a
    // narrowed vocabulary leaves behind.
    const stale = await createEnvironment(db, {
      name: "storage-metering-itest-stale",
    });
    const id = randomUUID();
    const reserved = await new Repository(db, stale.id).reserveMediaSlot({
      id,
      userId: null,
      filename: "archive.zip",
      mimeType: "application/zip",
      declaredBytes: 5_000,
      objectKey: `${stale.id}/${id}`,
    });
    expect(reserved.reserved).toBe(true);

    const res = await verdict(id, {
      verdict: "rejected",
      reason: "declaration_mismatch",
      verified_bytes: 1,
    });
    expect(res.status).toBe(200);

    // NO KIND MEANS NO RECORD, and the alternative is worse than silence: a record with
    // no kind lands as `''` in a `LowCardinality(String)` column, where 4.4 measured that
    // an absent field and an explicit empty string are indistinguishable — so the
    // per-kind count would grow a nameless bucket nothing could ever explain.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await eventsFor(stale.id)).toBe("");
    expect(await rollupFor(stale.id)).toEqual({ byKind: "{}", bytes: 0 });
  }, 60_000);

  it("counts uploads by kind, separately, summing to the day's total (SC-007)", async () => {
    // FR-009, THROUGH THE WHOLE PATH. The type was measured against the server in phase 2
    // — a plain `Map` under `SummingMergeTree` keeps the first row's value and drops the
    // rest — but that measurement was a direct INSERT. **A type that merges on insert and
    // not through a materialised view would be half a fix**, and this is the half a direct
    // insert cannot check.
    const mixed = await createEnvironment(db, {
      name: "storage-metering-itest-kinds",
    });
    const mixedKey = await createApiKey(db, { environmentId: mixed.id });
    expect((await slot(mixedKey.credential, 1_000, "image/png")).status).toBe(
      201,
    );
    expect((await slot(mixedKey.credential, 2_000, "image/png")).status).toBe(
      201,
    );
    expect((await slot(mixedKey.credential, 4_000, "audio/mpeg")).status).toBe(
      201,
    );

    const rollup = await rollupSettles(mixed.id, {
      byKind: "{'audio':1,'image':2}",
      bytes: 7_000,
    });
    expect(rollup.byKind).toBe("{'audio':1,'image':2}");
    // THE COUNTS SUM TO THE DAY'S TOTAL, which is the property a per-kind breakdown has
    // to have and the one a wrong merge breaks silently: with a plain `Map` the answer
    // here is `{'image':1}` — a smaller, plausible number.
    const counts = [...rollup.byKind.matchAll(/:(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(rollup.bytes).toBe(7_000);
  }, 90_000);

  it("keeps a rendition out of the count and inside the level (FR-010)", async () => {
    // **ONE ANSWER, ASSERTED AT BOTH READERS IN ONE TEST.** A rendition is not an upload
    // — nobody uploaded it — and its bytes are stored all the same. Two answers about one
    // object is how a count and a sum drift apart, and the two live in the same `SELECT`
    // in `0018`, so a test that checked one of them would be checking the wrong half.
    const derived = await createEnvironment(db, {
      name: "storage-metering-itest-rendition",
    });
    const derivedKey = await createApiKey(db, { environmentId: derived.id });
    const created = (await (
      await slot(derivedKey.credential, 50_000)
    ).json()) as {
      media_id: string;
    };
    const before = await rollupSettles(derived.id, {
      byKind: "{'image':1}",
      bytes: 50_000,
    });
    expect(before).toEqual({ byKind: "{'image':1}", bytes: 50_000 });

    const res = await verdict(created.media_id, {
      verdict: "ready",
      verified_bytes: 50_000,
      verified_type: "image/png",
      width: 1_200,
      height: 900,
      rendition: {
        id: randomUUID(),
        kind: "thumbnail",
        object_key: `${derived.id}/thumb`,
        bytes: 7_000,
        width: 320,
        height: 240,
      },
    });
    expect(res.status).toBe(200);

    // The level moves by the thumbnail's bytes — 4.15 measured a thumbnail at about 7 kB
    // whatever the parent — and the count does not move at all.
    const after = await rollupSettles(derived.id, {
      byKind: "{'image':1}",
      bytes: 57_000,
    });
    expect(after.bytes).toBe(57_000);
    expect(after.byKind).toBe("{'image':1}");
    expect(await eventsFor(derived.id)).toBe(
      "reserved\timage\t50000\nrendition\timage\t7000",
    );
  }, 90_000);
});
