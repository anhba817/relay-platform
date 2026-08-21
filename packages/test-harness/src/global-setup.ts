import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

import { databaseUrl } from "./db-url.js";

// Installed once per lane, before any test file (feature 030, T013).
//
// MIGRATES FIRST, and that is not tidiness. `globalSetup` runs before every suite,
// and six suites call `migrate(pool)` in their own `beforeAll` — that is, after
// this. On an unmigrated database `CREATE TRIGGER … ON webhook_endpoints` would hit
// a table that does not exist and the lane would die before a single test. CI is
// safe (`node services/api/dist/db/migrate.js` runs before `pnpm test:integration`)
// and `fresh-db.sh` migrates, so only a direct developer run was exposed — but
// depending on somebody else having migrated is not a property, it is a habit
// (research R25).
//
// `migrate` is idempotent, keyed on `schema_migrations`, so calling it here costs a
// no-op when the database is already current.

const PLATFORM = join(import.meta.dirname, "..", "..", "..");
const MIGRATE = join(PLATFORM, "services", "api", "dist", "db", "migrate.js");
const GUARD_SQL = join(import.meta.dirname, "sentinel.sql");

export default async function globalSetup(): Promise<void> {
  const connectionString = databaseUrl();

  // The migration runner is the api's build output. Failing here with a sentence
  // beats failing later inside a CREATE TRIGGER.
  const { migrate } = (await import(MIGRATE)) as {
    migrate: (pool: pg.Pool) => Promise<string[]>;
  };

  const pool = new pg.Pool({ connectionString });
  try {
    await migrate(pool);
    // The guard is applied by the LANE, never by a product migration — otherwise
    // the api ships a trigger whose only purpose is to reject its own legitimate
    // sweeps (constitution IV). `no-trigger-in-migrations.test.ts` asserts that.
    await pool.query(readFileSync(GUARD_SQL, "utf8"));
  } finally {
    await pool.end();
  }
}
