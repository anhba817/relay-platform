import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import { createEnvironment } from "../db/repository";
import { createAnalyticalStore, type AnalyticalStore } from "./clickhouse";
import { reconcile } from "./reconcile";

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

async function clearAnalytical(): Promise<void> {
  await ch(
    `ALTER TABLE relay_analytics.daily_usage_billing DELETE WHERE environment_id = '${environmentId}'`,
  );
  const done = await settle(async () => {
    const n = await ch(
      `SELECT count() FROM system.mutations WHERE database='relay_analytics' AND is_done = 0 FORMAT TSV`,
    );
    return Number(n) === 0;
  });
  if (!done) throw new Error("mutations did not finish; the next read would see leftovers");
}

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
const plantAnalytical = (day: string, messages: number, minutes: number): Promise<string> =>
  ch(
    `INSERT INTO relay_analytics.daily_usage_billing
       (environment_id, day, messages, active_users_state, stored_delta, connection_minutes)
     SELECT toUUID('${environmentId}'), toDate('${day}'), ${messages},
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
