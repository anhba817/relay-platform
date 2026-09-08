/** Where the harness connects, and why it is not simply `DATABASE_URL`.
 *
 * Every other package in this workspace falls back when the variable is unset —
 * `createPool()` reads `process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL` — so
 * `pnpm test:integration` works from a clean shell against the compose stack. The
 * harness's first version threw instead, which made the guard's own lane the only
 * task in the repository that required the variable, and broke the plain
 * `pnpm test:integration` a developer runs (research R50).
 *
 * The literal is duplicated rather than imported: this is a workspace package and
 * `services/api/src/db/client.ts` is service source, so importing it here would
 * point a package at a service. `db-url.test.ts` reads that file and fails if the
 * two ever disagree — the same shape `bait-size.test.ts` uses for the batch
 * constants, and for the same reason. A duplicated constant is fine; an
 * unwatched one is not.
 */
export const DEFAULT_DATABASE_URL = "postgres://relay:relay@localhost:15432/relay";

export function databaseUrl(): string {
  return process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
}
