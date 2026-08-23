import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "./db-url.js";
import { plant, sentinelFor } from "./sentinel.js";

// The guard's own tests. It is infrastructure every other lane now depends on, and
// it has two behaviours that are easy to get subtly wrong in opposite directions:
// refusing when it should not, and — the one this file exists for — CLAIMING TO
// PERMIT A WRITE WHILE DISCARDING IT.
//
// The second was real. A BEFORE UPDATE trigger returning OLD does not let the
// update through; it writes the old values back. With that bug an exempt suite
// swept 17 sentinel endpoints, disabled none of them, and found all 17 again on
// the next pass. Nothing raised, nothing logged, and `deliveries.itest.ts`'s
// "logs nothing when there is nothing to disable" failed with a number instead of
// a reason. No amount of guard-refuses-correctly testing would have found it.

const URL_ = databaseUrl();

function exempt(url: string, tables = "all"): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c relay.allow_global=${tables}`);
  return u.toString();
}

let guarded: pg.Client;
let permitted: pg.Client;
const s = sentinelFor("packages/test-harness/src/guard.itest.ts");

beforeAll(async () => {
  guarded = new pg.Client({ connectionString: URL_ });
  permitted = new pg.Client({ connectionString: exempt(URL_) });
  await Promise.all([guarded.connect(), permitted.connect()]);
  await plant(permitted, s);
}, 60_000);

afterAll(async () => {
  await Promise.all([guarded.end(), permitted.end()]);
});

describe("a connection without the exemption", () => {
  it("cannot update a sentinel row, and the message names the row", async () => {
    await expect(
      guarded.query("update webhook_endpoints set enabled = false where id = $1", [
        s.endpointId,
      ]),
    ).rejects.toThrow(
      new RegExp(
        `global-operation guard: this statement modified sentinel row ` +
          `public\\.webhook_endpoints \\(id ${s.endpointId}\\), which belongs to no ` +
          `test — the bait planted by ${s.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  });

  it("cannot delete one either", async () => {
    await expect(
      guarded.query("delete from webhook_endpoints where id = $1", [s.endpointId]),
    ).rejects.toThrow(/global-operation guard/);
  });

  it("is refused by the statement, so the row is unchanged", async () => {
    const r = await guarded.query<{ enabled: boolean }>(
      "select enabled from webhook_endpoints where id = $1",
      [s.endpointId],
    );
    expect(r.rows[0]?.enabled).toBe(true);
  });

  it("may still write rows that belong to no sentinel", async () => {
    // The trigger's WHEN clause is the whole point of the design: an ordinary
    // suite's own rows must not pay for the bait's protection.
    const other = sentinelFor("packages/test-harness/src/guard.itest.ts#bystander");
    await plant(permitted, other);
    await guarded.query(
      "delete from __sentinel_environments where environment_id = $1",
      [other.environmentId],
    );
    const r = await guarded.query(
      "update webhook_endpoints set enabled = false where id = $1",
      [other.endpointId],
    );
    expect(r.rowCount).toBe(1);
  });
});

describe("a connection carrying the exemption", () => {
  it("UPDATES THE ROW, and the new value is what the next reader sees", async () => {
    // The assertion that matters is the second one. `rowCount` was 1 while the
    // trigger was reverting the write, because one row was written — the old one.
    const w = await permitted.query(
      "update webhook_endpoints set enabled = false where id = $1",
      [s.endpointId],
    );
    expect(w.rowCount).toBe(1);

    const r = await permitted.query<{ enabled: boolean }>(
      "select enabled from webhook_endpoints where id = $1",
      [s.endpointId],
    );
    expect(r.rows[0]?.enabled).toBe(false);
  });

  it("deletes the row, and it stays deleted", async () => {
    // Children before parents — the same order `plant()` uses, and the same order
    // the delete has to take because the schema means it.
    for (const sql of [
      "delete from webhook_disable_notifications where environment_id = $1",
      "delete from webhook_deliveries where environment_id = $1",
    ]) {
      await permitted.query(sql, [s.environmentId]);
    }
    await permitted.query("delete from webhook_endpoints where id = $1", [
      s.endpointId,
    ]);
    const r = await permitted.query("select 1 from webhook_endpoints where id = $1", [
      s.endpointId,
    ]);
    expect(r.rowCount).toBe(0);
  });
});

describe("an exemption that names one table", () => {
  // The reason the exemption is not a per-file boolean. `notifications.itest.ts`
  // is on the list because it drives the notification relay, which is global over
  // `webhook_disable_notifications`. Under a file-wide pass the same file could
  // sweep `webhook_endpoints`, and that sweep is instance 6 — the fault this
  // feature exists for, in a file the guard had excused.
  let narrow: pg.Client;
  const n = sentinelFor("packages/test-harness/src/guard.itest.ts#narrow");

  beforeAll(async () => {
    narrow = new pg.Client({
      connectionString: exempt(URL_, "webhook_disable_notifications"),
    });
    await narrow.connect();
    await plant(permitted, n);
  }, 60_000);

  afterAll(async () => {
    await narrow.end();
  });

  it("may write the table it names", async () => {
    const r = await narrow.query(
      "update webhook_disable_notifications set last_status = 500 where endpoint_id = $1",
      // The notifications hang off the DISABLED endpoint, which is what a
      // disablement notification is about — see `plant()`.
      [n.deliveryEndpointId],
    );
    expect(r.rowCount).toBeGreaterThan(0);
  });

  it("is refused on a table it does not name", async () => {
    await expect(
      narrow.query("update webhook_endpoints set enabled = false where id = $1", [
        n.endpointId,
      ]),
    ).rejects.toThrow(/global-operation guard.*public\.webhook_endpoints/s);
  });
});

// ── THE FOUR USAGE TABLES (chapter 3.12, FR-038, SC-017) ─────────────────────
//
// Chapters 3.10 and 3.11 added `usage_periods`, `usage_active_users`,
// `quota_notifications` and `usage_connections`, and neither added them to
// `sentinel.sql`'s trigger array. A cross-environment UPDATE or DELETE on any of
// them passed for two chapters.
//
// BEING IN THE ARRAY IS NOT EVIDENCE OF BEING WATCHED, which is why this block
// drives all four rather than asserting the array's length. Chapter 3.10's SC-008
// passed by not being watched; a test that reads the source it is meant to check
// is the same mistake one layer up.
//
// The rows come from `plant()`'s bait 5 rather than from this file, and the first
// draft got that wrong in a way worth recording. It seeded its own
// `quota_notifications` row with `delivered_at` NULL — a CLAIMABLE row — and
// `createQuotaRelay` claims undelivered notifications across every environment.
// Thirteen tests failed in `quotas.itest.ts` and `connections.itest.ts`, two files
// that have nothing to do with this one, with a guard refusal naming a uuid this
// file had hardcoded. That is the fourth time the same law has been measured:
// **bait may be claimable only where draining it is database work.** `plant()`
// plants these already delivered for exactly that reason, and using its rows
// instead of inventing new ones is also how a refusal keeps naming its owner.
describe("the four usage tables chapters 3.10 and 3.11 left unguarded", () => {
  const u = sentinelFor("packages/test-harness/src/guard.itest.ts#usage");

  beforeAll(async () => {
    await plant(permitted, u);
  }, 60_000);

  const cases: [string, string, unknown[]][] = [
    [
      "usage_periods",
      "update usage_periods set messages_sent = 1 where environment_id = $1",
      [u.environmentId],
    ],
    [
      "usage_active_users",
      "delete from usage_active_users where environment_id = $1",
      [u.environmentId],
    ],
    [
      "quota_notifications",
      "update quota_notifications set last_error = 'probe' where environment_id = $1",
      [u.environmentId],
    ],
    [
      "usage_connections",
      "delete from usage_connections where environment_id = $1",
      [u.environmentId],
    ],
  ];

  for (const [table, statement, params] of cases) {
    it(`refuses a cross-environment write to ${table}, naming the table`, async () => {
      await expect(guarded.query(statement, params as never[])).rejects.toThrow(
        new RegExp(`global-operation guard.*public\\.${table}`, "s"),
      );
    });
  }

  // The key expression, tested for what it prints and not only for firing. Three
  // of these four have composite primary keys and no `id` column, so `OLD.id` —
  // what the message interpolated until this chapter — raises `record "old" has
  // no field "id"` at execution time. A guard that fails on the writes it permits
  // is worse than one that watches nothing, because it fails in the tests that
  // were right.
  it("prints the row when there is no id column, and the id when there is", async () => {
    await expect(
      guarded.query("delete from usage_periods where environment_id = $1", [u.environmentId]),
    ).rejects.toThrow(new RegExp(`\\(id \\{.*${u.environmentId}.*\\}\\)`, "s"));

    await expect(
      guarded.query("delete from quota_notifications where id = $1", [u.usageNotificationId]),
    ).rejects.toThrow(new RegExp(`\\(id ${u.usageNotificationId}\\)`));
  });

  // And the permitted connection still WRITES, which is the failure mode this
  // whole file exists for: a BEFORE trigger returning OLD claims to permit and
  // silently discards. Four tables added means four new chances at it.
  it("lets a named exemption through, and the write lands", async () => {
    const r = await permitted.query(
      "update usage_periods set messages_sent = 99 where environment_id = $1",
      [u.environmentId],
    );
    expect(r.rowCount).toBeGreaterThan(0);
    const back = await permitted.query(
      "select messages_sent from usage_periods where environment_id = $1",
      [u.environmentId],
    );
    expect(Number(back.rows[0].messages_sent)).toBe(99);
  });
});
