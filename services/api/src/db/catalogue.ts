import { sql } from "drizzle-orm";

import type { Db } from "./client";

// WHERE EVERY TABLE KEEPS ITS TENANT (FR-012, constitution I).
//
// The gauntlet attacks endpoints. This asks the other half of the question: a table
// that carries no path back to an environment is A LEAK WITH NO ENDPOINT YET — nothing
// is exposing it today, and the first query that joins it will.
//
// DERIVED FROM `information_schema`, NOT FROM `schema.ts`, because the database is what
// the queries run against. A table added by a migration and never modelled in Drizzle is
// invisible to a check that reads the model, and that is exactly the table this exists
// to catch.
//
// It lives here rather than in the test that calls it because this directory is the only
// place the lint ban permits `drizzle-orm` (constitution I, ADR-16). A catalogue query
// written inline in the test would need an exemption for as long as it lived.

/** How a row in this table is traced back to one environment. `hop` means
 * reached through a CHAIN of foreign keys, of any length — see the reachability
 * note in the query below for why the length matters and what it cost. */
export type TenantPath = "direct" | "hop" | "spine";

export interface TableClassification {
  table: string;
  /** `null` means the table matches none of the three, which fails the check. */
  path: TenantPath | null;
  /** For `hop`: the `direct` tables its foreign keys reach, following CHAINS of
   * keys and not only single links. Every name here is itself a
   * `direct` table, which is the invariant `tenant-scope.itest.ts` asserts. */
  via: string[];
  /** For `spine`: why it has no tenant column. */
  reason?: string;
}

// THE SPINE, AS A LIST WITH A REASON EACH AND NOT A PATTERN.
//
// A pattern silently absorbs the next table that happens to match it, which is the
// opposite of what this check is for. Adding a table here should be an edit somebody
// has to justify in writing, and the reason is stored so the justification outlives
// the person who made it.
//
// These six are tenancy itself — the tables an environment_id would point INTO — plus
// the migration ledger, which predates all of it.
const SPINE: ReadonlyArray<readonly [string, string]> = [
  ["organisations", "the root of the tenancy tree; nothing is above it to scope to"],
  ["applications", "belongs to an organisation, which is the scope"],
  ["environments", "IS the scope — an environment_id here would point at itself"],
  [
    "humans",
    "a person, not a tenant's record; one human may belong to several organisations",
  ],
  ["memberships", "joins humans to organisations, above the environment level"],
  [
    "schema_migrations",
    "the migration ledger; it predates tenancy and belongs to the database",
  ],
  // THE FIRST TABLE THIS CHECK HAS ACTUALLY REFUSED, and it refused it correctly.
  //
  // An outbox row is not a tenant's record — it is work the platform owes itself. The
  // environment travels inside `subject` and `payload`, so a consumer can filter, but
  // nothing reads this table on a tenant's behalf and no request path joins it.
  //
  // THAT ARGUMENT IS ABOUT READS, AND IT DOES NOT COVER RETENTION. The payload is a
  // full copy of the message, `text` included, and the relay marks rows published
  // rather than deleting them. So a message deleted from `messages` still has its words
  // in here, and nothing on this platform removes them. That is a real gap, it is not a
  // tenancy gap, and it is recorded here rather than argued away — the chapter that owns
  // per-environment retention owns the fix.
  // SECOND IN A ROW, AND FOR A DIFFERENT REASON THAN THE OUTBOX'S. The outbox holds a
  // copy of tenant data and argues that nothing reads it on a tenant's behalf. This
  // holds no tenant data at all: an event id and the fact that it was handled. There is
  // nothing in a row here to leak.
  [
    "consumed_events",
    "consumer bookkeeping — an event id and a timestamp, holding no tenant data to leak",
  ],
  [
    "outbox",
    "work the platform owes itself rather than a tenant's record; the environment " +
      "travels in `subject` and `payload` and no read path joins it",
  ],
];

/** The spine, for anyone who needs to state it rather than derive it. */
export const SPINE_TABLES: readonly string[] = SPINE.map(([t]) => t);

export interface CatalogueRow extends Record<string, unknown> {
  table_name: string;
  has_environment_id: boolean;
  fk_targets: string[] | null;
}

/** Every base table in `public`, each classified into exactly one of the three paths —
 * or into none, which is the answer that fails a build. */
export async function classifyTables(db: Db): Promise<TableClassification[]> {
  const rows = (
    await db.execute<CatalogueRow>(sql`
      WITH RECURSIVE base AS (
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ),
      direct AS (
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'environment_id'
      ),
      -- EVERY FOREIGN KEY IN public, AS AN EDGE LIST. Split out of the
      -- correlated subquery it used to live in, because reachability needs to
      -- walk it more than once.
      --
      -- ::text is load-bearing, AND IT MOVED UP HERE WITH THE CAST. information_schema
      -- columns are sql_identifier, and node-pg has no parser for an array of them: the
      -- row arrives as the literal string {channels,users} and iterating it yields a
      -- brace, which is how this was found rather than reasoned about. (No backticks in
      -- this comment: it is inside a template literal.)
      fk AS (
        SELECT DISTINCT tc.table_name::text AS src, ccu.table_name::text AS dst
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
         AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'public'
          AND tc.table_name <> ccu.table_name
      ),
      -- REACHABILITY, NOT ADJACENCY. The rule this check states
      -- is that every table has A PATH back to one environment, and the query
      -- used to accept only a path of length ONE: a foreign key landing
      -- directly on a table that carries environment_id. That covered every
      -- table there was, which is why nothing noticed.
      --
      -- message_edits is the first table two links away. It references
      -- messages, which references channels, which carries the column, and the
      -- one-hop query classified it as having no tenant at all. The check's own
      -- failure message offered three remedies and all three were wrong for it:
      -- denormalising a column the SAD does not publish, adding a second
      -- foreign key for the same reason, or calling a table of message text
      -- part of the spine.
      --
      -- So the query now matches the rule instead of the tables that happened
      -- to exist. This is not a weakening: it reports the DIRECT tables the
      -- chain arrives at, so the invariant tenant-scope.itest.ts asserts, that
      -- every entry in via is itself direct, holds exactly as before. A table
      -- that reaches nothing still classifies as null and still fails.
      --
      -- WITH RECURSIVE is required by the self-reference below, and it belongs
      -- on the FIRST cte in the chain even though base and direct are not
      -- recursive. Postgres reads the keyword once per WITH clause.
      --
      -- The walk is over table names in a schema of a few dozen, and UNION
      -- rather than UNION ALL terminates it on a cycle.
      reach AS (
        SELECT src, dst FROM fk
        UNION
        SELECT r.src, f.dst
        FROM reach r
        JOIN fk f ON f.src = r.dst
      )
      SELECT
        b.table_name,
        (b.table_name IN (SELECT table_name FROM direct)) AS has_environment_id,
        (
          SELECT array_agg(DISTINCT r.dst)
          FROM reach r
          WHERE r.src = b.table_name
            AND r.dst IN (SELECT table_name FROM direct)
        ) AS fk_targets
      FROM base b
      ORDER BY b.table_name
    `)
  ).rows;

  return rows.map(classifyRow);
}

/** THE CLASSIFICATION, SEPARATED FROM THE QUERY, and separated for a reason worth
 * stating: the interesting arm is the one that returns `null`, and it cannot execute
 * against a real database that has no unclassified table — which is exactly the state
 * this check exists to keep. So the branch that fires only when somebody adds a table
 * is the one branch a live run can never reach.
 *
 * Pure, so a unit test can drive all four arms with rows it makes up. A file with
 * nothing to mock has no reason to be partially tested. */
export function classifyRow(row: CatalogueRow): TableClassification {
  const via = row.fk_targets ?? [];
  // ORDER MATTERS, AND ONLY IN ONE PLACE: a spine table with no environment_id and no
  // foreign key classifies the same either way, but checking `direct` first means a
  // future spine table that GAINS the column reports as `direct` and its list entry
  // becomes visibly wrong rather than silently ignored.
  if (row.has_environment_id) return { table: row.table_name, path: "direct", via };
  if (via.length > 0) return { table: row.table_name, path: "hop", via };
  const reason = new Map(SPINE).get(row.table_name);
  if (reason !== undefined) return { table: row.table_name, path: "spine", via, reason };
  return { table: row.table_name, path: null, via };
}
