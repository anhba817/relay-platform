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
          -- ::text is load-bearing. information_schema columns are sql_identifier,
          -- and node-pg has no parser for an array of them: the row arrives as the
          -- literal string {channels,users} and iterating it yields a brace, which
          -- is how this was found rather than reasoned about.
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
