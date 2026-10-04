import { eq, isNotNull, sql } from "drizzle-orm";

import type { Db } from "./client";
import { environments } from "./schema";

// THE ONE READ IN THIS CHAPTER THAT CROSSES EVERY TENANT, AND IT LIVES HERE FOR THE
// REASON `storage-reads.ts` gives in its own header: `eslint.config.mjs` restricts
// `drizzle-orm` to `services/api/src/db/**` — *"the query engine lives inside the
// repository layer only (constitution I, ADR-16)"*.
//
// IT CANNOT BE A `Repository` METHOD. Constitution I requires that class's constructor
// to take an `environment_id`, and the question here is *which environments have a
// policy at all* — one answer for the whole platform rather than one per tenant.
// Everything after this read is scoped: the sweep constructs one `Repository` per
// environment it finds, which satisfies the constructor requirement literally rather
// than by exception.
//
// THE ISOLATION PROPERTY TO ASSERT IS THIS FUNCTION'S SIGNATURE, NOT AN ARM INSIDE IT.
// `pendingMediaObjects` says it for the sweep this one is modelled on: *"the route above
// it takes no tenant parameter at all, which is the isolation property to assert rather
// than a scope to add. A route that could be asked for one tenant's objects would be a
// route worth forging."* A probe hunting for a tenancy branch to delete here would
// report nothing red and mean something entirely different by it.
//
// READ-ONLY.

/** Every environment with a retention policy set — FR-MOD-06's population.
 *
 * Called by `sweepRetention` in `../retention/sweep.ts`, once per run, and by nothing
 * else. The convention `CLAUDE.md` sets: a claim about when a symbol runs names the
 * thing that runs it, because `ensureBucket` said *"on boot, every boot"* for two
 * chapters while every caller was a test.
 *
 * **IT RETURNS THE EMPTY SET TODAY**, on 0 of 33,051 environments, which is the whole
 * premise of the chapter this belongs to. The column has existed since chapter 2.1 and
 * nothing has ever written to it.
 *
 * AND WITHOUT `environments_retention_policy` THIS IS A SEQ SCAN OF THE WHOLE TABLE on
 * every sweep — 546 buffers and 1.346 ms with `Rows Removed by Filter: 33050`, paid
 * most often to learn that there is nothing to do. `0024` adds the partial index and
 * the same query becomes 1 buffer and 0.018 ms. */
export async function environmentsWithPolicy(
  db: Db,
): Promise<{ id: string; retentionDays: number }[]> {
  const rows = await db
    .select({
      id: environments.id,
      retentionDays: environments.retentionDays,
    })
    .from(environments)
    .where(isNotNull(environments.retentionDays));

  // The column is nullable and the predicate has already excluded the nulls; this
  // narrows the type without a second assertion about data the WHERE guarantees.
  return rows.map((row) => ({ id: row.id, retentionDays: row.retentionDays! }));
}

/** What `relay.expiring` reads as on this connection, right now.
 *
 * Called by `retention.itest.ts` and by nothing in the running platform. It exists
 * because the sweep's whole guarantee is one keyword and **both ways of getting it
 * wrong are silent**: set without `LOCAL`, the flag outlives its transaction on a
 * pooled connection and every later request can delete version rows; `SET LOCAL`
 * outside a transaction block is a WARNING rather than an error, so the flag is never
 * set and every cascade is refused in a way that looks exactly like the trigger doing
 * its job.
 *
 * Neither failure changes an exit code and neither changes a counted line, so the only
 * assertion that distinguishes them reads the value. `null` when unset — the
 * `missing_ok` arm of `current_setting`. */
export async function expiringFlag(db: Db): Promise<string | null> {
  const rows = await db.execute<{ flag: string | null }>(
    sql`SELECT current_setting('relay.expiring', true) AS flag`,
  );
  return rows.rows[0]?.flag ?? null;
}

/** One environment's policy, or null.
 *
 * Called by `isolation/gauntlet.itest.ts` and `retention.itest.ts`. The gauntlet needs
 * it because the attack it runs would be invisible otherwise: a forged PATCH that
 * answers 404 and writes the column anyway leaves no trace in any message listing, and
 * a message listing is what every other write attack in that suite reads. */
export async function retentionDaysOf(
  db: Db,
  environmentId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ retentionDays: environments.retentionDays })
    .from(environments)
    .where(eq(environments.id, environmentId));
  return row?.retentionDays ?? null;
}
