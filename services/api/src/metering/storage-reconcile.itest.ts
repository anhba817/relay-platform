import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import {
  createEnvironment,
  recordMediaVerdict,
  Repository,
} from "../db/repository";
import { presign } from "../media/presign";
import { deleteObject, ensureBucket, storeConfig } from "../media/store";
import { createAnalyticalStore, type AnalyticalStore } from "./clickhouse";
import {
  exitCodeFor,
  reconcileStorage,
  type StorageReport,
} from "./storage-reconcile";

// DR-17's COMPARISON AGAINST ALL THREE STORES (SC-006).
//
// **EVERY ASSERTION NAMES ITS OWN TENANT, AND HERE THAT IS NOT A CONVENTION — IT IS THE
// ONLY WAY THIS SUITE CAN PASS.** `reconcileStorage` takes no tenant: one listing returns
// the whole bucket and the report covers every environment the lane has ever had, 1,868 of
// them today. A whole-report assertion would be 045's whole-table shape with 1,868 rows of
// somebody else's data in it, and the neighbour that broke it would be a chapter from three
// features ago.
//
// AND THE ANALYTICAL STORE HAS NO LANE GUARD AT ALL (050-2), so nothing would stop an
// unscoped statement there either.

let db: Db;
let store: AnalyticalStore;
const config = storeConfig();

/** Four tenants, one per thing the comparison can say. Created in `beforeAll` so each id is
 *  this run's alone — the bucket persists between runs and a fixed id would inherit its own
 *  debris, which is 059-12's slow leak in a different table. */
let agreeing: string;
let high: string;
let low: string;
let oneSided: string;

const planted: string[] = [];

const ch = async (sql: string): Promise<string> => {
  const res = await fetch(
    `http://${process.env["RELAY_CLICKHOUSE_HOST"] ?? "localhost"}:${process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123"}/`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from("relay:relay").toString("base64"),
      },
      body: sql,
    },
  );
  const text = await res.text();
  if (!res.ok)
    throw new Error(text.trim().split("\n")[0] ?? "clickhouse refused");
  return text.trim();
};

/** A day of metered level for one tenant. `stored_bytes_delta` is a SIGNED delta and the
 *  comparison sums every day the rollup still holds, so one row is enough to state a level. */
const meter = (
  env: string,
  bytes: number,
  day = "2026-09-01",
): Promise<string> =>
  ch(
    `INSERT INTO relay_analytics.daily_usage_billing
       (environment_id, day, messages, active_users_state, stored_delta, connection_minutes,
        stored_bytes_delta, uploads_by_kind)
     SELECT toUUID('${env}'), toDate('${day}'), 0,
            uniqState(CAST(NULL AS Nullable(UUID))), 0, 0, ${bytes}, map()`,
  );

/** Bytes into the bucket under a tenant's prefix, through the signer the platform ships.
 *
 *  NOT A FIXTURE FILE AND NOT A SECOND CLIENT. `presign` plus `fetch` is exactly what a
 *  client does at 4.10, which means a test object and a real one are indistinguishable to
 *  the listing — and a listing that could tell them apart would not be testing anything. */
async function put(env: string, bytes: number): Promise<string> {
  const key = `${env}/${randomUUID()}`;
  const url = presign({
    method: "PUT",
    ...config,
    endpoint: config.internalEndpoint,
    key,
    expiresIn: 300,
  });
  const res = await fetch(url, { method: "PUT", body: Buffer.alloc(bytes, 7) });
  if (!res.ok) throw new Error(`PUT ${key}: ${res.status}`);
  planted.push(key);
  return key;
}

/** A charged slot nobody uploaded to — the explanatory term.
 *
 *  THROUGH `reserveMediaSlot` AND NOT AN INSERT. A hand-written row would have to restate
 *  the state, the key shape and the charged column, and a fixture that imitates a thing has
 *  to be usable everywhere the thing is or it is a landmine. It also keeps `drizzle-orm` out
 *  of this file, which `eslint.config.mjs` requires of everything outside `src/db/**`. */
async function reserve(env: string, bytes: number): Promise<string> {
  const id = randomUUID();
  const outcome = await new Repository(db, env).reserveMediaSlot({
    id,
    userId: null,
    filename: "reserved.png",
    mimeType: "image/png",
    declaredBytes: bytes,
    objectKey: `${env}/${id}`,
  });
  // THE FIXTURE ASSERTS THAT IT PLANTED SOMETHING. A quota refusal returns `reserved:
  // false` and this function would otherwise hand back an id for a row that does not
  // exist, and the test built on it would pass by measuring zero.
  expect(outcome.reserved).toBe(true);
  return id;
}

const rowFor = (report: StorageReport, env: string) =>
  report.rows.find((r) => r.environmentId === env);

beforeAll(async () => {
  expect(await ch("SELECT 1 FORMAT TSV")).toBe("1"); // a positive control, before anything
  db = createDb(createPool());
  store = createAnalyticalStore();
  await ensureBucket(config);
  const ids = await Promise.all(
    ["agreeing", "meter-high", "meter-low", "one-sided"].map((n) =>
      createEnvironment(db, { name: `storage-reconcile-${n}` }),
    ),
  );
  [agreeing, high, low, oneSided] = ids.map((e) => e.id) as [
    string,
    string,
    string,
    string,
  ];
});

afterAll(async () => {
  // A PROBE THAT WRITES TO THE LANE CLEANS UP AFTER ITSELF (043). These objects would
  // otherwise be counted by every later run of this suite and by the chapter's own
  // measurements, as `meter-low` bytes belonging to a tenant nobody remembers.
  await Promise.all(planted.map((key) => deleteObject(config, key)));
  for (const env of [agreeing, high, low, oneSided]) {
    if (env !== undefined) {
      await ch(
        `ALTER TABLE relay_analytics.daily_usage_billing DELETE WHERE environment_id = '${env}'`,
      );
    }
  }
});

describe("the meter against the store, tenant by tenant", () => {
  it("agrees when the bucket holds what the meter charged", async () => {
    await meter(agreeing, 4096);
    await put(agreeing, 4096);
    const report = await reconcileStorage(db, store, config);
    const row = rowFor(report, agreeing);
    expect(row?.metered).toBe(4096);
    expect(row?.inStore).toBe(4096);
    expect(row?.verdict).toBe("agree");
    expect(row?.drift).toBe(0);
  });

  it("names the direction when the meter charges for bytes the store has not got", async () => {
    // The `ready`-but-missing direction: charged, verified, and gone from the bucket.
    await meter(high, 100_000);
    await put(high, 1_000);
    const report = await reconcileStorage(db, store, config);
    const row = rowFor(report, high);
    expect(row?.verdict).toBe("meter-high");
    expect(row?.drift).toBeGreaterThan(0);
  });

  it("names the other direction, which is the one that is always wrong", async () => {
    // Bytes in the bucket that the meter has never heard of. No reservation explains this
    // one, and nothing in the platform corrects it.
    await meter(low, 1_000);
    await put(low, 100_000);
    const report = await reconcileStorage(db, store, config);
    const row = rowFor(report, low);
    expect(row?.verdict).toBe("meter-low");
    expect(row?.drift).toBeLessThan(0);
  });

  it("calls a tenant present on one side only what it is, and not a breach (FR-008)", async () => {
    // The rollup knows it and the bucket does not, because the listing DID finish: an
    // absent tenant holds zero rather than an unknown. What makes this `not-comparable`
    // instead is the other side — no rollup row at all, which 4.6's "a rollup created late
    // is permanently short" makes the ordinary case here rather than the exotic one.
    await put(oneSided, 2_048);
    const report = await reconcileStorage(db, store, config);
    const row = rowFor(report, oneSided);
    expect(row?.metered).toBeNull();
    expect(row?.inStore).toBe(2_048);
    expect(row?.verdict).toBe("not-comparable");
    expect(exitCodeFor([row!])).toBe(0);
  });

  it("subtracts a reservation only while the bucket has no key for it", async () => {
    // THE TERM, BOTH WAYS ROUND, IN ONE TEST. A charged slot with nothing uploaded is
    // explained; the same tenant's verdict must not change when an unrelated reservation
    // is satisfied. 267 of the lane's 6,580 pending rows name a key the bucket holds, so
    // the second half is the common case and not the edge.
    const env = (
      await createEnvironment(db, { name: "storage-reconcile-reserved" })
    ).id;
    await meter(env, 50_000);
    await put(env, 10_000);
    await reserve(env, 40_000);

    const explained = rowFor(await reconcileStorage(db, store, config), env);
    expect(explained?.reserved).toBe(40_000);
    expect(explained?.verdict).toBe("reservations-only");

    // Now upload to the reserved key. The row is still `pending` — only 4.13's sweep moves
    // it — but the bucket holds it, so it stops being outstanding and starts being counted.
    const id = await reserve(env, 7_000);
    const key = `${env}/${id}`;
    const url = presign({
      method: "PUT",
      ...config,
      endpoint: config.internalEndpoint,
      key,
      expiresIn: 300,
    });
    expect(
      (await fetch(url, { method: "PUT", body: Buffer.alloc(7_000, 3) })).ok,
    ).toBe(true);
    planted.push(key);

    const after = rowFor(await reconcileStorage(db, store, config), env);
    expect(after?.reserved).toBe(40_000); // the 7,000 is no longer outstanding
    expect(after?.inStore).toBe(17_000); // and the bucket counts it
    await ch(
      `ALTER TABLE relay_analytics.daily_usage_billing DELETE WHERE environment_id = '${env}'`,
    );
  });

  it("counts only a PENDING slot as outstanding, which the probe found nothing checked", async () => {
    // **T046's ARM A11.** Deleting `where(state = 'pending')` from `pendingMediaObjects`
    // turned nothing red across five suites — and the arm is plainly reachable, so that
    // was a fixture problem rather than a dead branch: every media row the other tests
    // plant is pending, so a read that returned all of them would give the same answer.
    // 061's finding exactly — *choosing the wrong suites looks like an uncovered arm* —
    // one level down, where it is the wrong FIXTURE.
    const env = (
      await createEnvironment(db, { name: "storage-reconcile-ready" })
    ).id;
    await meter(env, 30_000);
    const readyId = await reserve(env, 20_000);
    const stillPending = await reserve(env, 10_000);
    expect(stillPending).not.toBe(readyId);

    // The real transition, not an UPDATE: the object is verified and becomes `ready`.
    const applied = await recordMediaVerdict(db, {
      id: readyId,
      verdict: "ready",
      verifiedBytes: 20_000,
      verifiedType: "image/png",
    });
    expect(applied.applied).toBe(true);

    // Only the slot still waiting is outstanding. A `ready` object is one the platform
    // believes the store HOLDS, so counting it as an unfulfilled reservation would
    // explain away a gap the comparison exists to report.
    const row = rowFor(await reconcileStorage(db, store, config), env);
    expect(row?.reserved).toBe(10_000);
    expect(row?.inStore).toBe(0);
    // 30,000 metered, nothing in the bucket, 10,000 explained — 20,000 is not.
    expect(row?.verdict).toBe("meter-high");
    await ch(
      `ALTER TABLE relay_analytics.daily_usage_billing DELETE WHERE environment_id = '${env}'`,
    );
  });
});

describe("what the report says about itself", () => {
  it("reports how many tenants it examined and where they came from (FR-007)", async () => {
    const report = await reconcileStorage(db, store, config);
    // A ZERO THAT DOES NOT SAY WHAT IT LOOKED AT IS THIS PROJECT'S MOST-REPEATED
    // INSTRUMENT FAILURE. The union must be at least as large as each side it is made of,
    // and every tenant this suite planted must be inside it.
    expect(report.tenantsExamined).toBeGreaterThanOrEqual(report.sides.rollup);
    expect(report.tenantsExamined).toBeGreaterThanOrEqual(report.sides.bucket);
    expect(report.tenantsExamined).toBeGreaterThanOrEqual(
      report.sides.withMedia,
    );
    expect(report.tenantsExamined).toBe(report.rows.length);
    for (const env of [agreeing, high, low, oneSided]) {
      expect(report.rows.some((r) => r.environmentId === env)).toBe(true);
    }
  });

  it("reports the keys that belong to no tenant rather than dropping them", async () => {
    const report = await reconcileStorage(db, store, config);
    // Four such prefixes exist on this lane and NONE is on the listing's first page.
    expect(report.unattributable.keys).toBeGreaterThan(0);
    expect(report.inventory.truncated).toBe(false);
    expect(report.inventory.pages).toBeGreaterThan(0);
  });
});

describe("the reconciliation's own scope", () => {
  it("computes a tenant's verdict from that tenant's keys alone", async () => {
    // T039. **THE PROBE IS TO DELETE THE PREFIX TEST INSIDE `partitionByTenant`**, which
    // makes every key fall under one tenant and turns this red. Run at this chapter's
    // phase 4: with the split on `/` removed, the agreeing tenant reads `meter-high` by
    // the whole bucket.
    const before = rowFor(await reconcileStorage(db, store, config), agreeing);
    expect(before?.verdict).toBe("agree");

    // A neighbour's object, a hundred times the size, planted between two reads.
    const neighbour = (
      await createEnvironment(db, { name: "storage-reconcile-neighbour" })
    ).id;
    await put(neighbour, 409_600);

    const after = rowFor(await reconcileStorage(db, store, config), agreeing);
    expect(after?.inStore).toBe(before?.inStore);
    expect(after?.verdict).toBe("agree");
    // And the neighbour's bytes landed somewhere — otherwise this test passes because
    // nothing was written, which is the control 4.10's tamper probe needed.
    expect(
      rowFor(await reconcileStorage(db, store, config), neighbour)?.inStore,
    ).toBe(409_600);
  });
});
