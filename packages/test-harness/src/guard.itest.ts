import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "./db-url.js";
import { plant, sentinelFor, type Sentinel } from "./sentinel.js";

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

// A THIRD SENTINEL THAT ONLY `plant()` EVER TOUCHES. Everything else in this file
// plants the victim's rows through `SHAPES`, which is right for the refusal cases and
// useless for asking whether `plant()` itself covers the array — a question about the
// function every OTHER integration suite depends on.
const CANARY = sentinelFor("packages/test-harness/src/guard.itest.ts#canary");

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
  // COMMENT LINES FIRST, and this is not tidiness. The array's own comments contain
  // quoted strings — the chapter that added `read_positions` explained the refusal
  // message's `to_jsonb(OLD) ->> 'id'` right there — and a naive scan for quoted
  // lower-case words took `id` for a table. The suite then ran five cases against a
  // table called `id`, all of which failed, and the report named a table nobody had
  // written. A parser over a language it does not parse has to at least know what a
  // comment is.
  const body = block[1]!
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const names = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  if (names.length === 0) {
    throw new Error("sentinel.sql's table array parsed empty, which would make every case below vacuous");
  }
  return names;
})();

/** ONE ENTRY PER GUARDED TABLE: how to plant a row in it, and a column an UPDATE can
 * touch. Asserted against `GUARDED` in both directions below.
 *
 * WHY THIS IS A TABLE AND NOT A CONVENTION. The generated cases used
 * `SET metadata = '{}'::jsonb` for every guarded table, which worked for exactly as
 * long as every guarded table had a `metadata` column. `read_positions` does not, and
 * the report said `column "metadata" of relation "read_positions" does not exist` —
 * five cases failing on a column, in a suite about a trigger.
 *
 * And the victim fixture had the same shape problem from the other side: it planted a
 * `users` row and a `channels` row because those were the two tables, so adding a
 * third left the trigger with nothing to match and an unscoped DELETE went through.
 * A guard test whose fixture does not cover a guarded table reports that table as
 * unguarded and is right.
 */
interface Shape {
  plant: string;
  values: (s: Sentinel) => unknown[];
  /** A no-op-safe assignment for the refusal cases: they must reach the trigger, and
   * what they set is irrelevant. */
  touch: string;
  /** A detectable assignment for the exemption case, with the read that checks it. */
  mark: string;
  read: string;
  marked: (n: number) => unknown;
}

const SHAPES: Readonly<Record<string, Shape>> = {
  users: {
    plant: `INSERT INTO users (id, environment_id, external_id, display_name)
            VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING`,
    values: (s) => [s.userId, s.environmentId, s.name],
    touch: `metadata = '{}'::jsonb`,
    mark: `metadata = $1::jsonb`,
    read: `SELECT metadata AS v FROM users WHERE environment_id = $1`,
    marked: (n) => ({ "guard-probe": String(n) }),
  },
  channels: {
    plant: `INSERT INTO channels (id, environment_id, external_id, type, name)
            VALUES ($1, $2, $3, 'private', $3) ON CONFLICT (id) DO NOTHING`,
    values: (s) => [s.channelId, s.environmentId, s.name],
    touch: `metadata = '{}'::jsonb`,
    mark: `metadata = $1::jsonb`,
    read: `SELECT metadata AS v FROM channels WHERE environment_id = $1`,
    marked: (n) => ({ "guard-probe": String(n) }),
  },
  read_positions: {
    plant: `INSERT INTO read_positions (environment_id, channel_id, user_id, sequence)
            VALUES ($1, $2, $3, 0) ON CONFLICT (channel_id, user_id) DO NOTHING`,
    values: (s) => [s.environmentId, s.channelId, s.userId],
    // `sequence` rather than `metadata`, because this table has no metadata — and
    // `updated_at` would be touched by a trigger on some tables, so a column nothing
    // else writes is the honest choice.
    touch: `sequence = sequence`,
    // NOT `metadata`, AND NOT KEYED ON `id`. This table has neither. The mark is a
    // sequence value nothing else writes and the read is scoped by environment, which
    // works for all three tables and does not assume a surrogate key — the absence of
    // one being the reason this table joined the guard with a message change.
    mark: `sequence = $1`,
    read: `SELECT sequence AS v FROM read_positions WHERE environment_id = $1`,
    marked: (n) => n,
  },
  // THE QUOTA CHAPTER'S THREE. Two of them have no `metadata` and no `id`, which is
  // the shape `read_positions` above already forced this table to accommodate — so
  // these three cost three entries and no change to the mechanism, which is what a
  // table of shapes is for.
  //
  // Each marks a column nothing else in the fixture writes, and each reads back scoped
  // by environment. `usage_periods.messages_sent` is a count, so the mark is a number
  // and the `touch` is the no-op `messages_sent = messages_sent`: the refusal cases
  // only have to REACH the trigger, and a case that changed the count would leave the
  // suite unable to tell a refusal from an arithmetic mistake.
  usage_periods: {
    plant: `INSERT INTO usage_periods (environment_id, period, messages_sent)
            VALUES ($1, $2, 0) ON CONFLICT (environment_id, period) DO NOTHING`,
    values: (s) => [s.environmentId, s.quotaPeriod],
    touch: `messages_sent = messages_sent`,
    mark: `messages_sent = $1`,
    read: `SELECT messages_sent AS v FROM usage_periods WHERE environment_id = $1`,
    // `bigint` comes back from `pg` as a STRING, not a number — the driver will not
    // narrow a 64-bit integer into a float — so the expectation is the string. Found
    // by the case failing with `expected '7' to be 7`, which is the whole reason this
    // is a per-table function rather than one shared expectation.
    marked: (n) => String(n),
  },
  usage_active_users: {
    plant: `INSERT INTO usage_active_users (environment_id, period, user_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (environment_id, period, user_id) DO NOTHING`,
    values: (s) => [s.environmentId, s.quotaPeriod, s.userId],
    // Every column of this table is either the key or `first_seen_at`, so the mark has
    // to be the timestamp — there is nothing else to write. It takes an epoch offset so
    // two marks in one run differ.
    touch: `first_seen_at = first_seen_at`,
    mark: `first_seen_at = to_timestamp($1)`,
    read: `SELECT extract(epoch from first_seen_at)::bigint AS v
             FROM usage_active_users WHERE environment_id = $1`,
    marked: (n) => String(n),
  },
  quota_notifications: {
    plant: `INSERT INTO quota_notifications
              (id, environment_id, organisation_id, period, dimension, threshold,
               quota, usage_at_crossing)
            VALUES ($1, $2, $3, $4, 'messages', 50, 1, 1)
            ON CONFLICT (id) DO NOTHING`,
    values: (s) => [s.quotaNotificationId, s.environmentId, s.organisationId, s.quotaPeriod],
    touch: `last_error = last_error`,
    mark: `last_error = $1::text`,
    read: `SELECT last_error AS v FROM quota_notifications WHERE environment_id = $1`,
    marked: (n) => String(n),
  },
  // The connection-metering chapter's, and the first guarded table whose key does not
  // start with the environment. `minutes` is the mark for the same reason
  // `usage_periods` uses its count: it is the column nothing else in this fixture
  // writes, and a `bigint` comes back from `pg` as a string.
  usage_connections: {
    plant: `INSERT INTO usage_connections
              (connection_id, period, environment_id, minutes)
            VALUES ($1, $2, $3, 0)
            ON CONFLICT (connection_id, period) DO NOTHING`,
    values: (s) => [s.usageConnectionId, s.quotaPeriod, s.environmentId],
    touch: `minutes = minutes`,
    mark: `minutes = $1`,
    read: `SELECT minutes AS v FROM usage_connections WHERE environment_id = $1`,
    marked: (n) => String(n),
  },
};

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
  // THROUGH `SHAPES`, so a table added to the guard's array is planted here by
  // construction rather than by somebody remembering.
  for (const table of GUARDED) {
    const shape = SHAPES[table]!;
    await admin.query(shape.plant, shape.values(VICTIM));
  }

  // AND THE CANARY, THROUGH THE REAL FUNCTION. `plant()` is what `setup.ts` runs once
  // per test file, so this is the only place in the suite where it is exercised at all.
  await plant(admin, CANARY);

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
  for (const table of GUARDED) {
    const shape = SHAPES[table]!;
    await admin.query(shape.plant, shape.values(NEIGHBOUR));
  }
});

afterAll(async () => {
  // Children before parents, and through `admin` because deleting a sentinel row
  // is exactly what the guard forbids.
  for (const s of [VICTIM, NEIGHBOUR]) {
    // REVERSED, so children go before parents: `read_positions` references both of
    // the others, and the array is written creation-order.
    for (const t of [...GUARDED].reverse()) {
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
  it("has a shape for every guarded table and no shape for anything else", () => {
    // THE COMMENT ON `SHAPES` CLAIMED THIS AND THE SUITE DID NOT MAKE IT. Every use
    // site writes `SHAPES[table]!`, so a guarded table with no entry throws
    // `Cannot read properties of undefined` from inside a fixture — a message about
    // JavaScript, in a suite about a trigger, naming no table.
    //
    // BOTH DIRECTIONS. A missing entry is the failure above; an extra one is a table
    // that used to be guarded and is not, which leaves a fixture planting rows the
    // trigger no longer protects and nothing anywhere going red.
    expect(Object.keys(SHAPES).sort()).toEqual([...GUARDED].sort());
  });

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

  it("plants a sentinel row in every guarded table, so the canary is never missing", async () => {
    // THE THIRD DIRECTION, AND IT WAS THE ONE NOBODY ASSERTED. `sentinel.sql` says the
    // name, the bait and the case "go together" — and two of the three were checked
    // against each other while the bait was checked by nothing. Measured: deleting the
    // `usage_periods` insert from `plant()` left this suite at 32 of 32 green, and
    // deleting `read_positions`' — an older chapter's — did too.
    //
    // WHAT THAT COSTS IS NOT THIS SUITE. Every case below plants its OWN row through
    // `SHAPES`, so this file is unaffected by a missing insert. What `plant()` is for is
    // every OTHER integration suite: `setup.ts` runs it once per test FILE, and the row
    // it leaves is what makes an unscoped `DELETE FROM usage_periods` in somebody
    // else's suite meet a trigger at all. A name added to the array with a shape and no
    // bait leaves that table with no canary in any lane run, and reads as protection.
    //
    // ASKED OF THE DATABASE, not of `sentinel.ts`'s source. A source scan would pass on
    // an insert that runs and inserts nothing — `ON CONFLICT DO NOTHING` against a row
    // this fixture does not own, say — which is the shape a fixture fails in.
    // AGAINST THE CANARY, AND THE FIRST VERSION OF THIS USED THE VICTIM — which is
    // planted through `SHAPES` in `beforeAll`, so every count was nonzero for a reason
    // that had nothing to do with `plant()`. It stayed green with the insert deleted,
    // twice, which is exactly the vacuity this assertion was written to end.
    const missing: string[] = [];
    for (const table of GUARDED) {
      const { rows } = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE environment_id = $1`,
        [CANARY.environmentId],
      );
      if (rows[0]!.n === "0") missing.push(table);
    }
    expect(
      missing,
      `guarded, and plant() leaves no row to guard: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  for (const table of GUARDED) {
    it(`refuses an unscoped UPDATE on ${table}`, async () => {
      // No WHERE at all — the shape a global sweep has. The refusal must name the
      // table and the owner, because a bare failure sends the next reader to the
      // wrong file.
      await expect(
        plain.query(`UPDATE ${table} SET ${SHAPES[table]!.touch}`),
      ).rejects.toThrow(/global-operation guard/);
    });

    it(`refuses an unscoped DELETE on ${table}, naming SOME owner`, async () => {
      // Asserted on the MESSAGE, not just on rejection: the diagnosis is the
      // feature. A refusal that does not say whose bait it was leaves the reader
      // grepping for a uuid.
      //
      // "SOME owner", NOT OURS, AND THAT DISTINCTION COST A LANE RUN. An unscoped
      // DELETE trips on whichever sentinel row Postgres reaches first, and which
      // one that is depends on who else is in the database. Pinned to this file's
      // own owner it passed alone and failed in the coverage lane, where the
      // refusal named `services/api/src/isolation/targets.itest.ts` instead —
      // an assertion scoped wider than the thing it tests, failing for somebody
      // else's reason. The case below pins the owner properly.
      await expect(plain.query(`DELETE FROM ${table}`)).rejects.toThrow(
        new RegExp(`global-operation guard.*${table}.*the bait planted by \\S+\\.itest\\.ts`, "s"),
      );
    });

    it(`names THIS file's owner when the row can only be ours`, async () => {
      // Scoped to one environment and still refused, because scoping to a TENANT
      // is not the same as being allowed to mutate a sentinel. This is the only
      // shape that can assert the owner, since it is the only shape whose victim
      // is not decided by row order.
      await expect(
        plain.query(`DELETE FROM ${table} WHERE environment_id = $1`, [
          VICTIM.environmentId,
        ]),
      ).rejects.toThrow(
        new RegExp(
          `global-operation guard.*${table}.*${VICTIM.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          "s",
        ),
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
      const shape = SHAPES[table]!;
      const n = 1 + GUARDED.indexOf(table);
      const value = shape.marked(n);
      await admin.query(
        `UPDATE ${table} SET ${shape.mark} WHERE environment_id = $2`,
        [typeof value === "object" ? JSON.stringify(value) : value, VICTIM.environmentId],
      );
      const { rows } = await admin.query<{ v: unknown }>(shape.read, [VICTIM.environmentId]);
      expect(rows[0]?.v, `the exempt write to ${table} was reverted`)
        .toEqual(typeof value === "object" ? value : String(value));
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
        `UPDATE ${table} SET ${SHAPES[table]!.touch} WHERE environment_id = $1`,
        [NEIGHBOUR.environmentId],
      );
      expect(res.rowCount, `no ${table} row in the neighbour environment to permit`)
        .toBe(1);
    });
  }
});
