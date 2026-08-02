import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type pg from "pg";

import { createPool } from "./client";

// Migrations as discipline (constitution: versioned, forward-only). There is
// no down path — not missing, absent by design. Files apply in filename
// order, each inside a transaction, each recorded; a re-run is a no-op.
// drizzle-kit GENERATES these files from src/db/schema.ts; this runner —
// not drizzle-kit's migrator — is the only thing that APPLIES them, so the
// workspace has exactly one migration ledger: schema_migrations.

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];

  for (const file of files) {
    const done = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [file],
    );
    if ((done.rowCount ?? 0) > 0) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return applied;
}

// This package compiles to CommonJS (ADR-15's dialect), so the "am I the
// entry file?" check is require.main — import.meta does not exist here.
if (require.main === module) {
  void (async () => {
    const pool = createPool();
    const applied = await migrate(pool);
    console.log(
      applied.length === 0
        ? "migrations: nothing to apply"
        : `migrations: applied ${applied.join(", ")}`,
    );
    await pool.end();
  })();
}
