import { eq, sql } from "drizzle-orm";

import type { Db } from "./client";
import { mediaObjects } from "./schema";

// THE OPERATIONAL THIRD OF DR-17's COMPARISON, AND IT LIVES HERE FOR `usage-reads.ts`'s
// REASON: `eslint.config.mjs` restricts `drizzle-orm` to `services/api/src/db/**` —
// *"the query engine lives inside the repository layer only (constitution I, ADR-16)"*.
// Chapter 4.7's reconciler was written with its Postgres read inline in `metering/` and
// failed lint on the import; this file is where that rule puts the read.
//
// A SEPARATE FILE FROM `usage-reads.ts`, WHICH IS FR-ANL-06's. That one's header names one
// clause and this is another, and the split costs nothing: `usage-reads.ts` is titled in one
// tutorial fence and this file in none.
//
// AND A THIRD READER OF `media_objects` THAT IS NOT `Repository`. That class is tenant-scoped
// around `this.environmentId`; a reconciliation sweeps every tenant at once, because the
// instrument on the other side — one listing of one bucket — is not per tenant either.
//
// READ-ONLY. The reconciler compares and writes nothing.

/** A slot charged to the quota whose object may or may not exist yet.
 *
 * **WHY THE KEY AND NOT JUST A SUM.** The obvious read is
 * `sum(declared_bytes) … where state = 'pending'` grouped by tenant, and it is wrong by a
 * measurable amount: on this lane **267 of the 6,580 pending rows name a key the store
 * actually holds**, 6,533,174 declared bytes of them — 21% of everything the bucket
 * contains. Subtracting those as "outstanding" would remove bytes that are on both sides of
 * the comparison and push the tenant into a false `meter-low`.
 *
 * So the explanatory term cannot be computed from Postgres alone: **which reservations are
 * still outstanding is a question only the inventory can answer**, and this read exists to
 * hand `outstandingReservations` the keys it needs to ask it. */
export interface PendingObject {
  environmentId: string;
  objectKey: string;
  declaredBytes: number;
}

/** Every pending slot in the platform, tenant by tenant.
 *
 * UNSCOPED ON PURPOSE, AND IT IS THE ONLY READ IN THIS FILE THAT IS. DR-17's comparison is
 * per tenant and its instrument is not: one signed listing returns the whole bucket, so the
 * reconciliation holds every tenant at once and the scope is applied when the rows are
 * partitioned by key prefix. A per-tenant read here would be one statement per tenant beside
 * one listing for all of them.
 *
 * **AND IT IS A BATCH JOB'S READ.** 6,580 rows on this lane; at a scale where that is
 * millions, so is the inventory it is compared against, and the pair is the cost of asking
 * DR-17's question at all. Called by `reconcileStorage`, which nothing but
 * `scripts/reconcile-storage.mjs` and its tests call. */
export async function pendingMediaObjects(db: Db): Promise<PendingObject[]> {
  const rows = await db
    .select({
      environmentId: mediaObjects.environmentId,
      objectKey: mediaObjects.objectKey,
      declaredBytes: mediaObjects.declaredBytes,
    })
    .from(mediaObjects)
    .where(eq(mediaObjects.state, "pending"));
  return rows.map((r) => ({
    environmentId: r.environmentId,
    objectKey: r.objectKey,
    declaredBytes: Number(r.declaredBytes),
  }));
}

/** Every tenant the platform believes holds a media object, in any state.
 *
 * **A FOURTH SIDE, AND IT CLOSES A BLIND SPOT THE FIRST DESIGN HAD.** That version took the
 * population to be the union of the rollup, the bucket and the outstanding reservations —
 * which silently omits the tenant DR-17 most wants to hear about: one whose objects are all
 * `ready`, whose keys the bucket does not hold, and which the rollup has never heard of. It
 * appears on none of the three and is examined by nobody, while the platform is charging it
 * for bytes that exist nowhere. The lane holds **1,074 ready rows naming a key the bucket
 * does not have**, so this is measured rather than imagined.
 *
 * IDS AND NOT A COUNT. A count answers *how many could have been asked*, and the union needs
 * *which* — 1,678 uuids is nothing beside an inventory of the same bucket. */
export async function environmentsWithMedia(db: Db): Promise<string[]> {
  const rows = await db.execute(
    sql`select distinct environment_id from media_objects`,
  );
  return (rows.rows as { environment_id: string }[]).map((r) => r.environment_id);
}
