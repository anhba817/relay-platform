import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const URL_ = process.env["DATABASE_URL"];
if (URL_ === undefined) throw new Error("DATABASE_URL is required");

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
      "delete from webhook_disable_notifications where endpoint_id = $1",
      "delete from webhook_deliveries where endpoint_id = $1",
    ]) {
      await permitted.query(sql, [s.endpointId]);
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
      "update webhook_disable_notifications set delivered_at = now() where endpoint_id = $1",
      [n.endpointId],
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
