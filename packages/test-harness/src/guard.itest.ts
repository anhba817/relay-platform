import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "./db-url.js";
import { sentinelFor } from "./sentinel.js";

// THE GUARD, DRIVEN ONE TABLE AT A TIME.
//
// `sentinel.sql` names the guarded tables in an array and installs a trigger for
// each. Installing a trigger is cheap and silent, and it is not the same as being
// watched: the WHEN clause tests `__is_sentinel(OLD.environment_id)`, so a table
// with no sentinel row in it installs a trigger that can never match. A passing
// lane looks identical either way.
//
// So every name in that array gets a case here, and the case does the thing the
// guard exists to forbid — an UPDATE and a DELETE with no tenant predicate, over a
// row belonging to another file's sentinel. Remove a name from the array and its
// two cases go red. That is the property; the array on its own asserts nothing.
//
// WHY THIS FILE IS NOT ON THE EXEMPT LIST. It is not performing a global operation
// — it is provoking one and expecting to be refused. An exemption would switch the
// trigger off and every expectation below would invert without the file changing.

const url = new URL(databaseUrl());
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error(
    `integration tests refuse non-local databases (got host "${url.hostname}")`,
  );
}

// A VICTIM THAT IS NOT THIS FILE'S OWN SENTINEL. The trigger fires for any
// registered sentinel's rows, and using our own would still pass — but it would
// pass for a weaker reason, since a suite mutating its own bait is a mistake the
// guard is not there to catch. Naming somebody else's makes the refusal the point.
const VICTIM = sentinelFor("packages/test-harness/src/guard.itest.ts#victim");

// A NEIGHBOUR THAT IS NOT A SENTINEL, holding a row in every guarded table. The
// permissive half of each pair needs a row the trigger DECLINES to refuse, and a
// predicate matching nothing is not that: `BEFORE UPDATE FOR EACH ROW` never fires
// over zero rows, so an update that matches none passes under a trigger refusing
// everything. Measured, not reasoned about — the first version of this file scoped
// its permitted update to an id nothing held, and it stayed green with the WHEN
// clause deleted from the trigger.
const NEIGHBOUR = sentinelFor("packages/test-harness/src/guard.itest.ts#neighbour");

// READ OUT OF `sentinel.sql`, not restated. A second copy of the list would agree
// with the first by somebody remembering, and the cases below are generated from
// it — so a table added to the array arrives here with its cases already written,
// and one removed takes its cases with it. Parsing beats copying wherever the
// parse can fail loudly, which is what the length assertion is for.
const GUARDED: readonly string[] = (() => {
  const sql = readFileSync(join(import.meta.dirname, "sentinel.sql"), "utf8");
  const block = /FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/.exec(sql);
  if (block === null) {
    throw new Error(
      "guard.itest.ts cannot find sentinel.sql's table array — the shape it parses changed",
    );
  }
  const names = [...block[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  if (names.length === 0) {
    throw new Error("sentinel.sql's table array parsed empty, which would make every case below vacuous");
  }
  return names;
})();

let admin: pg.Client;
let plain: pg.Client;

beforeAll(async () => {
  // Two clients on purpose. `admin` carries the exemption and plants the victim;
  // `plain` carries none and is what the expectations run through. One client
  // doing both would mean every refusal below depended on a SET landing on the
  // connection the query happened to get.
  const exempt = new URL(url.toString());
  exempt.searchParams.set("options", "-c relay.allow_global=on");
  admin = new pg.Client({ connectionString: exempt.toString() });
  plain = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await plain.connect();

  await admin.query(
    `INSERT INTO __sentinel_environments (environment_id, owner) VALUES ($1, $2)
     ON CONFLICT (environment_id) DO UPDATE SET owner = EXCLUDED.owner`,
    [VICTIM.environmentId, VICTIM.owner],
  );
  await admin.query(
    `INSERT INTO organisations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [VICTIM.organisationId, VICTIM.name],
  );
  await admin.query(
    `INSERT INTO applications (id, organisation_id, name)
     VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [VICTIM.applicationId, VICTIM.organisationId, VICTIM.name],
  );
  await admin.query(
    `INSERT INTO environments (id, application_id, kind, signing_secret)
     VALUES ($1, $2, 'development', $3) ON CONFLICT (id) DO NOTHING`,
    [VICTIM.environmentId, VICTIM.applicationId, `sentinel-not-a-secret-${VICTIM.environmentId}`],
  );
  await admin.query(
    `INSERT INTO users (id, environment_id, external_id, display_name)
     VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING`,
    [VICTIM.userId, VICTIM.environmentId, VICTIM.name],
  );
  await admin.query(
    `INSERT INTO channels (id, environment_id, external_id, type, name)
     VALUES ($1, $2, $3, 'private', $3) ON CONFLICT (id) DO NOTHING`,
    [VICTIM.channelId, VICTIM.environmentId, VICTIM.name],
  );

  // The neighbour's tenancy, DELIBERATELY NOT registered in
  // `__sentinel_environments` — that omission is the whole point of these rows.
  await admin.query(
    `INSERT INTO organisations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [NEIGHBOUR.organisationId, NEIGHBOUR.name],
  );
  await admin.query(
    `INSERT INTO applications (id, organisation_id, name)
     VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [NEIGHBOUR.applicationId, NEIGHBOUR.organisationId, NEIGHBOUR.name],
  );
  await admin.query(
    `INSERT INTO environments (id, application_id, kind, signing_secret)
     VALUES ($1, $2, 'development', $3) ON CONFLICT (id) DO NOTHING`,
    [NEIGHBOUR.environmentId, NEIGHBOUR.applicationId, `sentinel-not-a-secret-${NEIGHBOUR.environmentId}`],
  );
  await admin.query(
    `INSERT INTO users (id, environment_id, external_id, display_name)
     VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING`,
    [NEIGHBOUR.userId, NEIGHBOUR.environmentId, NEIGHBOUR.name],
  );
  await admin.query(
    `INSERT INTO channels (id, environment_id, external_id, type, name)
     VALUES ($1, $2, $3, 'private', $3) ON CONFLICT (id) DO NOTHING`,
    [NEIGHBOUR.channelId, NEIGHBOUR.environmentId, NEIGHBOUR.name],
  );
});

afterAll(async () => {
  // Children before parents, and through `admin` because deleting a sentinel row
  // is exactly what the guard forbids.
  for (const s of [VICTIM, NEIGHBOUR]) {
    for (const t of ["channels", "users"]) {
      await admin.query(`DELETE FROM ${t} WHERE environment_id = $1`, [s.environmentId]);
    }
    await admin.query(`DELETE FROM environments WHERE id = $1`, [s.environmentId]);
    await admin.query(`DELETE FROM applications WHERE id = $1`, [s.applicationId]);
    await admin.query(`DELETE FROM organisations WHERE id = $1`, [s.organisationId]);
    await admin.query(`DELETE FROM __sentinel_environments WHERE environment_id = $1`, [s.environmentId]);
  }
  await admin.end();
  await plain.end();
});

describe("the guard refuses an unscoped mutation of a sentinel row", () => {
  it("installs one trigger per name in sentinel.sql's array, and no more", async () => {
    // BOTH DIRECTIONS. A name in the array with no trigger means the DO block
    // failed silently; a trigger with no name means a stale install survived a
    // removal, and `DROP TRIGGER IF EXISTS` only covers names still in the array.
    const { rows } = await plain.query<{ tgname: string; relname: string }>(
      `SELECT t.tgname, c.relname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname LIKE '__sentinel_guard_%' AND NOT t.tgisinternal`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...GUARDED].sort());
  });

  for (const table of GUARDED) {
    it(`refuses an unscoped UPDATE on ${table}`, async () => {
      // No WHERE at all — the shape a global sweep has. The refusal must name the
      // table and the owner, because a bare failure sends the next reader to the
      // wrong file.
      await expect(
        plain.query(`UPDATE ${table} SET metadata = '{}'::jsonb`),
      ).rejects.toThrow(/global-operation guard/);
    });

    it(`refuses an unscoped DELETE on ${table}, and names the owner`, async () => {
      // Asserted on the MESSAGE, not just on rejection: the diagnosis is the
      // feature. A refusal that does not say whose bait it was leaves the reader
      // grepping for a uuid.
      await expect(plain.query(`DELETE FROM ${table}`)).rejects.toThrow(
        new RegExp(`global-operation guard.*${table}.*${VICTIM.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "s"),
      );
    });

    it(`lets an EXEMPT connection's UPDATE on ${table} actually land`, async () => {
      // THE EXEMPTION PATH, and the assertion is the VALUE READ BACK — not the
      // row count, and not the absence of a throw.
      //
      // A BEFORE UPDATE trigger returning OLD does not permit the update: it
      // replaces it with a write of the old values. `rowCount` is 1 either way and
      // nothing throws, so a guard that reverts every exempt write looks exactly
      // like one that permits them. The symptom shows up somewhere else entirely —
      // an exempt sweep that disables the same rows on every pass and never runs
      // out — which is a long way from the file holding the fault.
      const mark = `{"guard-probe":"${table}"}`;
      await admin.query(
        `UPDATE ${table} SET metadata = $1::jsonb WHERE id = $2`,
        [mark, table === "channels" ? VICTIM.channelId : VICTIM.userId],
      );
      const { rows } = await admin.query<{ metadata: unknown }>(
        `SELECT metadata FROM ${table} WHERE id = $1`,
        [table === "channels" ? VICTIM.channelId : VICTIM.userId],
      );
      expect(rows[0]?.metadata, `the exempt write to ${table} was reverted`)
        .toEqual(JSON.parse(mark));
    });

    it(`permits a scoped UPDATE on ${table} that hits a non-sentinel row`, async () => {
      // THE OTHER HALF, and without it every expectation above passes under a
      // trigger that refuses everything.
      //
      // `rowCount` IS THE ASSERTION, not the absence of a throw. An update matching
      // zero rows also does not throw, and that is how this case was wrong the
      // first time: it named an environment nothing held, so it stayed green with
      // the trigger's WHEN clause deleted. One row has to change hands for the
      // permission to have been exercised.
      const res = await plain.query(
        `UPDATE ${table} SET metadata = '{}'::jsonb WHERE environment_id = $1`,
        [NEIGHBOUR.environmentId],
      );
      expect(res.rowCount, `no ${table} row in the neighbour environment to permit`)
        .toBe(1);
    });
  }
});
