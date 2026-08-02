import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema";

// The one place a connection is born. DATABASE_URL defaults to the compose
// stack's dev credentials (chapter 1.2) — override it if your host ports
// are remapped. Everything outside src/db is lint-forbidden from importing
// pg OR drizzle-orm at all (constitution I: isolation lives in data
// access) — Drizzle is the query engine INSIDE the repository layer, never
// a client handed to handlers (ADR-16).

export const DEFAULT_DATABASE_URL =
  "postgres://relay:relay@localhost:15432/relay";

export function createPool(): pg.Pool {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
}

export type Db = NodePgDatabase<typeof schema>;

export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema });
}
