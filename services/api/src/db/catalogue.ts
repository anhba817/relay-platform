import { sql } from "drizzle-orm";

import type { Db } from "./client";

// WHERE EVERY TABLE KEEPS ITS TENANT (FR-012, constitution I).
//
// The gauntlet attacks endpoints. This asks the other half of the question: a
// table that carries no path back to an environment is a leak with no endpoint
// yet — nothing is exposing it today, and the first query that joins it will.
//
// Derived from `information_schema` rather than from `schema.ts`, because the
// database is what the queries run against. A table added by a migration and
// never modelled in Drizzle is invisible to a check that reads the model, and
// that is exactly the table this exists to catch.
//
// It lives HERE rather than in the test that calls it because this directory is
// the only place the lint ban permits `drizzle-orm` (constitution I, ADR-16).
// T069a restores that ban for integration tests, where a second flat-config
// block had been replacing the rule instead of merging with it (R23) — so a
// catalogue query written inline in the test would need an exemption for as long
// as it lived.

/** How a row in this table is traced back to one environment. */
export type TenantPath = "direct" | "hop" | "spine";

export interface TableClassification {
  table: string;
  /** `null` means the table matches none of the three, which fails the check. */
  path: TenantPath | null;
  /** For `hop`: the `direct` tables its foreign keys reach. */
  via: string[];
  /** For `spine`: why it has no tenant column. */
  reason?: string;
}

// THE SPINE, as a list with a reason each and not a pattern.
//
// Feature 030 made this argument first and it holds here: a pattern silently
// absorbs the next table that happens to match it, which is the opposite of what
// this check is for. Adding a table to this list should be an edit somebody has
// to justify.
//
// The first six are tenancy itself — the tables an environment_id would point
// INTO. The last two are infrastructure, and they are the two worth arguing
// about:
//
// `consumed_events` and `outbox` are not records, they are bookkeeping. Neither
// is on a read path to any API caller. The outbox's only reader is the relay,
// whose entire job is to publish every environment's events without regard to
// which environment they came from — see the retention note below for what that
// costs and what it does not cost.
const SPINE: ReadonlyArray<readonly [string, string]> = [
  ["organisations", "the root of the tenancy tree; nothing is above it to scope to"],
  ["applications", "belongs to an organisation, which is the scope"],
  ["environments", "IS the scope — an environment_id here would point at itself"],
  ["humans", "a person, not a tenant's record; one human may belong to several organisations"],
  ["memberships", "joins humans to organisations, above the environment level"],
  ["consumed_events", "consumer bookkeeping, on no read path to any caller"],
  ["schema_migrations", "the migration ledger; it predates tenancy and belongs to the database"],
  // THE OUTBOX KEEPS MESSAGE TEXT FOR EVER, and that is a RETENTION finding
  // rather than a tenancy one. An earlier draft of this feature had it in a
  // fourth class called `unscoped`, on the reading that it violated Principle
  // I's second clause. Three of the four arguments for that collapsed on
  // checking, so the class had one member and then none (R7).
  //
  // What is true, measured rather than reasoned about (R7a):
  //   - `drainOutbox` sets `published_at = now()` and never deletes.
  //   - Nothing in the api deletes a row from any table. The only `.delete(` in
  //     non-test source is an in-memory Map eviction in `limits/fallback.ts:85`.
  //   - The payload is a full copy of the message, `data.text` included.
  //   - 286,871 rows in the test lane.
  //
  // Four requirements collide with that. DR-06 and FR-MSG-08: a deleted message
  // keeps its row with `text` cleared, and hard deletion runs only through the
  // compliance endpoint — but the text survives in the payload, and a tombstone
  // that leaves a copy behind is not a tombstone. FR-TEN-08: 30-day erasure of
  // an application's operational data, unreachable for these rows by any
  // mechanism that exists today. FR-MOD-06: per-environment retention with a
  // scheduled hard-delete job, which is the requirement that owns the fix.
  //
  // The fix is one statement and needs no tenant identifier:
  //
  //     DELETE FROM outbox WHERE published_at < now() - interval 'N days'
  //
  // For the rare per-tenant compliance sweep, `subject`'s last segment already
  // carries the environment id and the payload carries the key.
  //
  // Adding `environment_id` would have been the wrong fix, and the reasoning is
  // the useful part. The outbox's legitimate mutation IS cross-environment, so a
  // tenant column would make feature 030's guard refuse the relay's own sweep —
  // `exempt.ts`'s line "`outbox` is not among them and needs no entry" was
  // right. And a foreign key to `environments` would block deleting an
  // environment while outbox rows existed, which makes FR-TEN-08 harder rather
  // than easier.
  //
  // Owned by whichever chapter builds FR-MOD-06 — Phase 3 and Part 4, not this
  // one. Named here with its numbers so it is not rediscovered a third time.
  ["outbox", "platform bookkeeping; its only reader is the relay, which is global by design"],
];

/** The spine, for anyone who needs to state it rather than derive it. */
export const SPINE_TABLES: readonly string[] = SPINE.map(([t]) => t);

export interface CatalogueRow extends Record<string, unknown> {
  table_name: string;
  has_environment_id: boolean;
  fk_targets: string[] | null;
}

/**
 * Every base table in `public`, each classified into exactly one of the three
 * paths — or into none, which is the answer that fails a build.
 */
export async function classifyTables(db: Db): Promise<TableClassification[]> {
  const rows = (
    await db.execute<CatalogueRow>(sql`
      WITH base AS (
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ),
      direct AS (
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'environment_id'
      )
      SELECT
        b.table_name,
        (b.table_name IN (SELECT table_name FROM direct)) AS has_environment_id,
        (
          -- ::text is load-bearing. information_schema columns are
          -- sql_identifier, and node-pg has no parser for an array of them --
          -- the row arrives as the literal string {channels,users} and
          -- iterating it yields a brace, which is how this was found.
          -- (No backticks in here: this is inside a template literal.)
          SELECT array_agg(DISTINCT ccu.table_name::text)
          FROM information_schema.table_constraints tc
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
            AND tc.table_name = b.table_name
            AND ccu.table_name IN (SELECT table_name FROM direct)
        ) AS fk_targets
      FROM base b
      ORDER BY b.table_name
    `)
  ).rows;

  return rows.map(classifyRow);
}

/** THE CLASSIFICATION, SEPARATED FROM THE QUERY, and separated for a reason the
 * coverage run made plain: the interesting arm is the one that returns `null`, and
 * it cannot execute against a real database that has no unclassified table — which
 * is exactly the state the check exists to keep. So the branch that fires only when
 * somebody adds a table was the one branch nothing measured.
 *
 * Pure, so `catalogue.test.ts` drives all four arms with rows it makes up. Same
 * argument as `webhooks/disable.ts` and `webhooks/analytics.ts`, which are pure and
 * pinned at 100 for it: a file with nothing to mock has no reason to be partially
 * tested. */
export function classifyRow(row: CatalogueRow): TableClassification {
  const via = row.fk_targets ?? [];
  // ORDER MATTERS, and only in one place: a spine table with no environment_id
  // and no foreign key would classify the same either way, but checking
  // `direct` first means a future spine table that gains the column reports as
  // `direct` and the list entry becomes visibly wrong rather than silently
  // ignored.
  if (row.has_environment_id) return { table: row.table_name, path: "direct", via };
  if (via.length > 0) return { table: row.table_name, path: "hop", via };
  const reason = new Map(SPINE).get(row.table_name);
  if (reason !== undefined) return { table: row.table_name, path: "spine", via, reason };
  return { table: row.table_name, path: null, via };
}
