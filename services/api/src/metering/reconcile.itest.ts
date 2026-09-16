import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import { createEnvironment, creditConnectionMinutes } from "../db/repository";
import { createAnalyticalStore, type AnalyticalStore } from "./clickhouse";
import { exitCodeFor, RECONCILE_THRESHOLD, reconcile } from "./reconcile";

// FR-ANL-06's job, against both stores.
//
// EVERY STATEMENT NAMES ITS TENANT, ON BOTH SIDES, FOR TWO DIFFERENT REASONS. The analytical
// store has no lane guard at all (050-2), so nothing would stop an unscoped statement; and
// `usage_periods` and `usage_active_users` both carry feature 030's sentinel trigger while the
// api's integration lane sets `RELAY_HARNESS_BAIT: "on"` — unlike the gateway's, which carries
// none. One store because nothing will stop you, the other because something will.

let db: Db;
let store: AnalyticalStore;
let environmentId: string;
const PERIOD = "2026-04-01";
const UNTIL = "2026-05-01";

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
  if (!res.ok) throw new Error(text.trim().split("\n")[0] ?? "clickhouse refused");
  return text.trim();
};

async function clearAnalytical(env: string = environmentId): Promise<void> {
  await ch(
    `ALTER TABLE relay_analytics.daily_usage_billing DELETE WHERE environment_id = '${env}'`,
  );
  const done = await settle(async () => {
    const n = await ch(
      `SELECT count() FROM system.mutations WHERE database='relay_analytics' AND is_done = 0 FORMAT TSV`,
    );
    return Number(n) === 0;
  });
  if (!done) throw new Error("mutations did not finish; the next read would see leftovers");
}

/** How many rollup rows this tenant has. The cleanup ASSERTS on this rather than trusting the
 *  mutation poll above — 4.6's suite trusted a bare `ALTER … DELETE`, read three creations
 *  where it had planted two, and the poll was that repair. Reading the count is one step
 *  further on: it checks the outcome instead of the queue. */
const analyticalRows = async (env: string): Promise<number> =>
  Number(
    await ch(
      `SELECT count() FROM relay_analytics.daily_usage_billing
        WHERE environment_id = toUUID('${env}') FORMAT TSV`,
    ),
  );

async function settle(p: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await p()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Plant a rollup row. `sum()` over no rows returns 0, so an EMPTY result set rather than a
 *  zero is what "the analytical side holds nothing" looks like — which is why the tests below
 *  distinguish an absent side from a zero one. */
const plantAnalytical = (
  day: string,
  messages: number,
  minutes: number,
  env: string = environmentId,
): Promise<string> =>
  ch(
    `INSERT INTO relay_analytics.daily_usage_billing
       (environment_id, day, messages, active_users_state, stored_delta, connection_minutes)
     SELECT toUUID('${env}'), toDate('${day}'), ${messages},
            uniqState(CAST(NULL AS Nullable(UUID))), 0, ${minutes}`,
  );

beforeAll(async () => {
  expect(await ch("SELECT 1 FORMAT TSV")).toBe("1"); // a positive control, before anything
  db = createDb(createPool());
  store = createAnalyticalStore();
  const env = await createEnvironment(db, { name: "reconcile-itest" });
  environmentId = env.id;
  await clearAnalytical();
});

afterAll(async () => {
  await clearAnalytical();
});

describe("the job compares both stores for one tenant and one period", () => {
  it("reports four quantities, each with its operational source named", async () => {
    const rows = await reconcile(db, store, { environmentId, period: PERIOD });
    expect(rows.map((r) => r.quantity)).toEqual([
      "messages",
      "activeUsers",
      "connectionMinutes",
      "storedMessages",
    ]);
    expect(rows.find((r) => r.quantity === "messages")?.operationalSource).toBe("usage_periods");
    expect(rows.find((r) => r.quantity === "activeUsers")?.operationalSource).toBe(
      "usage_active_users",
    );
    // No operational source anywhere, which is a fact about the platform and not this tenant.
    expect(rows.find((r) => r.quantity === "storedMessages")?.operationalSource).toBeNull();
  });

  it("calls the stored count not-comparable, however much analytical data exists", async () => {
    const rows = await reconcile(db, store, { environmentId, period: PERIOD });
    expect(rows.find((r) => r.quantity === "storedMessages")?.verdict).toBe("not-comparable");
  });

  it("calls a tenant with nothing on either side no-data, not agreement", async () => {
    // A fresh environment has no `usage_periods` row and no rollup rows. Zero against zero is
    // not agreement, and the first green number this chapter published would have been a lie.
    const rows = await reconcile(db, store, { environmentId, period: PERIOD });
    expect(rows.find((r) => r.quantity === "messages")?.verdict).toBe("no-data");
    expect(rows.find((r) => r.quantity === "messages")?.differencePct).toBeNull();
  });

  it("calls analytical-only a breach, which is the direction a stream makes possible", async () => {
    await plantAnalytical("2026-04-10", 500, 40);
    const rows = await reconcile(db, store, { environmentId, period: PERIOD });
    const m = rows.find((r) => r.quantity === "messages");
    expect(m?.analytical).toBe(500);
    expect(m?.operational).toBeNull();
    expect(m?.verdict).toBe("breach");
    await clearAnalytical();
  });

  it("returns the same report twice, because it writes nothing", async () => {
    const a = await reconcile(db, store, { environmentId, period: PERIOD });
    const b = await reconcile(db, store, { environmentId, period: PERIOD });
    expect(b).toEqual(a);
  });

  it("uses a HALF-OPEN day range, so the next month's first day is not this month's", async () => {
    // The off-by-one that does not crash: `BETWEEN period AND nextPeriod(period)` would put
    // 1 May into April and report the difference as drift.
    await plantAnalytical("2026-04-30", 100, 10);
    await plantAnalytical(UNTIL, 999_999, 999_999);
    const rows = await reconcile(db, store, { environmentId, period: PERIOD });
    expect(rows.find((r) => r.quantity === "messages")?.analytical).toBe(100);
    expect(rows.find((r) => r.quantity === "connectionMinutes")?.analytical).toBe(10);
    await clearAnalytical();
  });

  it("returns an empty result set as no rows, which is what makes the count() necessary", async () => {
    // THE ARM THAT IS REACHABLE, BESIDE THE ONE THAT IS NOT. `store.query` answers `[]` when
    // the server sends an empty body, and a filtered non-aggregate does exactly that. A bare
    // `sum()` never does — it answers one row whatever the filter matches — which is the whole
    // reason `reconcile` counts rows instead of checking for an empty result.
    expect(await store.query("SELECT 1 WHERE 0 FORMAT TSV")).toEqual([]);
    expect(await store.query("SELECT sum(1) WHERE 0 FORMAT TSV")).toEqual([["0"]]);
  });

  it("surfaces the server's refusal as the first line of its answer", async () => {
    // A query that fails must not read as a tenant with no data. The store throws; the caller
    // has no arm for it, so a broken read fails the job rather than reporting a false zero.
    await expect(store.query("SELECT no_such_column FROM system.one FORMAT TSV")).rejects.toThrow(
      /Code: 47/,
    );
  });

  it("keeps a second tenant's rows unreachable from this one's filter", async () => {
    const other = await createEnvironment(db, { name: "reconcile-itest-other" });
    await ch(
      `INSERT INTO relay_analytics.daily_usage_billing
         (environment_id, day, messages, active_users_state, stored_delta, connection_minutes)
       SELECT toUUID('${other.id}'), toDate('2026-04-15'), 7_000,
              uniqState(CAST(NULL AS Nullable(UUID))), 0, 0`,
    );
    const mine = await reconcile(db, store, { environmentId, period: PERIOD });
    expect(mine.find((r) => r.quantity === "messages")?.analytical).toBeNull();
    const theirs = await reconcile(db, store, { environmentId: other.id, period: PERIOD });
    expect(theirs.find((r) => r.quantity === "messages")?.analytical).toBe(7_000);
    await ch(
      `ALTER TABLE relay_analytics.daily_usage_billing DELETE WHERE environment_id = '${other.id}'`,
    );
  });
});

// ---------------------------------------------------------------------------
// THE PLANTED DRIFT — `docs/12` §2.3's CI half (chapter 4.7, phase 4).
//
// *"0.1% of a small number is an assertion that cannot fail for its own reason."* So the lane
// does not measure agreement. It plants a disagreement, checks that the job raises, removes it,
// and checks that the job goes quiet — because **a check that only ever fires is not a check**,
// and this project has run the coverage-threshold probe both ways five times for that reason.
//
// THE QUANTITY IS CONNECTION-MINUTES BECAUSE IT IS THE ONLY ONE THE REPOSITORY CAN PLANT.
// `usage_periods.messages_sent` is incremented one at a time by `sendMessage`, inside the
// transaction that writes the message, so an operational total of 100,000 messages costs
// 100,000 sends. `creditConnectionMinutes` takes the number as an argument — the gateway reports
// a total rather than a tick — so the same figure costs one call. Nothing here needed a raw
// `INSERT`, which is what keeps this file outside `eslint.config.mjs`'s exemption list.
// ---------------------------------------------------------------------------

describe("the planted drift, and the same assertion not firing once it is removed", () => {
  let driftEnv: string;

  /** 100,000, and the size is the whole point. At the lane's real scale — a tenant with nine
   *  connection-minutes — 0.1% is 0.009 of a minute and no integer drift lands inside the
   *  threshold at all, so a "boundary" test there would be asserting that 1 ≠ 0. */
  const OPERATIONAL = 100_000;
  const DAY = "2026-04-12";

  /** Replace the analytical side with one figure. CLEAR FIRST, EVERY TIME: the target is a
   *  `SummingMergeTree` keyed `(environment_id, day)` and the read is `sum()`, so a second
   *  plant on the same day ADDS to the first rather than replacing it. */
  async function setAnalytical(minutes: number): Promise<void> {
    await clearAnalytical(driftEnv);
    expect(await analyticalRows(driftEnv)).toBe(0); // T035: verify the cleanup, then plant
    await plantAnalytical(DAY, 0, minutes, driftEnv);
  }

  const minutesRow = async () =>
    (await reconcile(db, store, { environmentId: driftEnv, period: PERIOD })).find(
      (r) => r.quantity === "connectionMinutes",
    );

  beforeAll(async () => {
    const env = await createEnvironment(db, { name: "reconcile-drift-itest" });
    driftEnv = env.id;
    // The operational side, through the shipped path. One report, one connection, one call.
    await creditConnectionMinutes(db, [
      {
        connectionId: randomUUID(),
        environmentId: driftEnv,
        period: PERIOD,
        minutes: OPERATIONAL,
      },
    ]);
  });

  afterAll(async () => {
    // BOTH SIDES ARE NAMED; ONLY ONE IS DELETED, AND THE ASYMMETRY IS DELIBERATE.
    //
    // The analytical rows must go: they accumulate under `sum()` and no foreign key, no lane
    // reset and no TTL inside this run will remove them. The operational rows stay, because
    // `reset-lane.mjs` purges lane debris and not data by design — Postgres held 31,215
    // environments at feature 045's close-out — and they belong to an environment id nothing
    // else in the lane can name. Deleting them would also mean a raw `DELETE` in a file that
    // currently needs no driver exemption.
    await clearAnalytical(driftEnv);
    expect(await analyticalRows(driftEnv)).toBe(0);
  });

  it("raises for that tenant and that quantity when the drift is larger than the threshold", async () => {
    await setAnalytical(99_000); // 1% short of the operational figure
    const rows = await reconcile(db, store, { environmentId: driftEnv, period: PERIOD });

    const minutes = rows.find((r) => r.quantity === "connectionMinutes");
    expect(minutes?.analytical).toBe(99_000);
    expect(minutes?.operational).toBe(OPERATIONAL);
    expect(minutes?.differencePct).toBeCloseTo(0.01, 12);
    expect(minutes?.verdict).toBe("breach");

    // AND THE OTHER QUANTITIES DO NOT RAISE, which is the half that makes the first one mean
    // something. `creditConnectionMinutes` wrote the `usage_periods` row with `messages_sent`
    // at its default 0, and the plant put 0 messages in the rollup: two present sides, both
    // zero, which this job calls agreement rather than a division.
    expect(rows.find((r) => r.quantity === "messages")?.verdict).toBe("pass");
    expect(rows.find((r) => r.quantity === "activeUsers")?.verdict).toBe("pass");

    // FR-008: the raise is a value a test can read, not a line a human notices.
    expect(exitCodeFor(rows)).toBe(1);
  });

  it("does not raise once the drift is removed", async () => {
    await setAnalytical(OPERATIONAL);
    const rows = await reconcile(db, store, { environmentId: driftEnv, period: PERIOD });
    const minutes = rows.find((r) => r.quantity === "connectionMinutes");
    expect(minutes?.analytical).toBe(OPERATIONAL);
    expect(minutes?.differencePct).toBe(0);
    expect(minutes?.verdict).toBe("pass");
    expect(exitCodeFor(rows)).toBe(0);
  });

  // THE BOUNDARY, AT A SCALE WHERE IT EXISTS — and the two obvious plantings BOTH PASS.
  //
  // `differencePct` divides by `max(analytical, operational)`, so the threshold is not
  // symmetric in percent. Against an operational 100,000:
  //
  //     analytical    difference       pct     verdict
  //         99,900          -100   0.100000%   pass      "0.1% under" — the naive shortfall
  //         99,899          -101   0.101000%   breach
  //        100,100          +100   0.099900%   pass      "0.1% over"  — the naive excess
  //        100,101          +101   0.100898%   breach
  //
  // Anyone planting `operational * 1.001` to make the job fire gets a PASS and concludes the
  // job is broken; anyone planting `operational * 0.999` gets a pass too, because the
  // comparison is `<=`. The smallest breaching drift is 101 in both directions, and the
  // percentages at those two points differ — which is the asymmetry, stated in the one place
  // it can be checked.
  it.each([
    [99_900, "pass"],
    [99_899, "breach"],
    [100_100, "pass"],
    [100_101, "breach"],
  ] as const)("puts analytical %i on the %s side of the bound", async (minutes, verdict) => {
    await setAnalytical(minutes);
    expect((await minutesRow())?.verdict).toBe(verdict);
  });

  it("agrees with the unit test's arithmetic at both boundary points", async () => {
    // The unit suite asserts these two numbers with no store at all. Asserting them again here
    // is what says the integration path computes the same thing — the gathering could return
    // the right verdict off a wrong figure and only the figure would show it.
    await setAnalytical(99_900);
    expect((await minutesRow())?.differencePct).toBe(RECONCILE_THRESHOLD);
    await setAnalytical(100_100);
    expect((await minutesRow())?.differencePct).toBeCloseTo(100 / 100_100, 15);
  });
});
