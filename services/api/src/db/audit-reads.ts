import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import type { Db } from "./client";
import { auditLog } from "./schema";

// FR-006's READ, AND IT LIVES HERE FOR `storage-reads.ts`'s REASON: `eslint.config.mjs`
// restricts `drizzle-orm` to `services/api/src/db/**` — *"the query engine lives inside the
// repository layer only (constitution I, ADR-16)"*. Chapter 4.7's reconciler was written
// with its Postgres read inline in `metering/` and failed lint on the import; chapter 4.16
// repeated the mistake one directory over. This file is where that rule puts the read, and
// `audit/audit.reader.ts` holds everything that is not SQL.
//
// NOT A METHOD ON `Repository`, AND THE REASON IS NOT SIZE. That class is constructed per
// request with an actor context so that its WRITES can be attributed; this is a read, it
// attributes nothing, and giving it a home there would mean a page of a tenant's history
// depended on the same object that records history. The tenancy predicate is a required
// parameter instead, which is exactly as strong as `this.environmentId` and visible at the
// call site.
//
// READ-ONLY, and the table refuses anything else at the storage layer anyway.

/** One entry, as the column names have it. Shaping into the contract's `actor` and
 *  `target` objects is the reader's job, not the query's. */
export interface AuditRow {
  id: string;
  occurredAt: Date;
  actorKind: string;
  actorId: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  requestId: string;
}

export interface AuditPageQuery {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  action?: string | undefined;
  /** One more than the caller asked for — the `has_more` convention. */
  limit: number;
  /** The keyset position to continue after, newest first. */
  after?: { occurredAt: Date; id: string } | undefined;
}

/** One page of a tenant's moderation history, newest first.
 *
 * THE TENANT ID IS THE CODE'S AND NEVER THE CALLER'S (constitution I). It arrives from the
 * principal the authentication middleware resolved from a credential, and there is no
 * query parameter that names an environment.
 *
 * THE CURSOR IS A SQL ROW VALUE, AND THE EXPANDED FORM IS NOT THE SAME THING. The first
 * version of this function wrote `occurred_at < $1 OR (occurred_at = $1 AND id < $2)`, with
 * a comment claiming the planner treats it identically. T032a measured it and it does not:
 *
 *     the OR form     Index Cond: (environment_id … AND occurred_at >= … AND occurred_at < …)
 *                     Filter: ((occurred_at < …) OR ((occurred_at = …) AND (id < …)))
 *                     Rows Removed by Filter: 51     on page 2
 *                                            201     on page 5
 *     the ROW form    Index Cond: (… AND ROW(occurred_at, id) < ROW(…, …))
 *                     no Filter, no rows removed
 *
 * The OR form cannot be pushed into the index, so the scan starts at the top of the window
 * and discards every row of every earlier page — O(page depth × limit) — which is the exact
 * cost keyset pagination exists to avoid. It is invisible at lane scale and it is the whole
 * point of the mechanism. Chapter 4.13's rule said where to look: *a predicate the planner
 * cannot push down returns an index scan carrying a `Filter:`*, so `Index Cond` is the
 * question and `Index Scan` is not.
 *
 * Drizzle has no row-value constructor, which is why this is `sql`. What it must NOT be is
 * a comparison on `occurred_at` alone — that column is not unique, and
 * `request-log/reader.ts` carries the measurement: 42 pairs in one lane hold more than one
 * row and a single-column comparison skips or repeats all 89.
 *
 * `LIMIT` IS THE CALLER'S PLUS ONE and the reader drops the extra. Without it a page that
 * exactly exhausts the window advertises a next page that turns out empty. */
export async function auditPage(
  db: Db,
  environmentId: string,
  query: AuditPageQuery,
): Promise<AuditRow[]> {
  return auditPageQuery(db, environmentId, query);
}

/** The same statement, unawaited, so a test can ask the planner about it.
 *
 * ONE BUILDER AND TWO CONSUMERS, which is the point. `audit.itest.ts` runs `EXPLAIN` over
 * `.toSQL()` of this object and asserts the cursor comparison reaches the `Index Cond` —
 * a claim that is only worth anything if the statement it explains is the statement the
 * route sends. A plan test that re-types the query by hand is a second implementation
 * agreeing with itself. */
export function auditPageQuery(
  db: Db,
  environmentId: string,
  query: AuditPageQuery,
) {
  const where = [
    eq(auditLog.environmentId, environmentId),
    gte(auditLog.occurredAt, query.from),
    lt(auditLog.occurredAt, query.to),
  ];
  if (query.action !== undefined) where.push(eq(auditLog.action, query.action));
  if (query.after !== undefined) {
    const { occurredAt, id } = query.after;
    where.push(
      sql`(${auditLog.occurredAt}, ${auditLog.id}) < (${occurredAt}::timestamptz(3), ${id}::uuid)`,
    );
  }
  return db
    .select({
      id: auditLog.id,
      occurredAt: auditLog.occurredAt,
      actorKind: auditLog.actorKind,
      actorId: auditLog.actorId,
      action: auditLog.action,
      targetKind: auditLog.targetKind,
      targetId: auditLog.targetId,
      requestId: auditLog.requestId,
    })
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
    .limit(query.limit);
}

/** Every distinct action this tenant's entries actually hold.
 *
 * THE OTHER HALF OF THE FILTER'S VOCABULARY (`audit.schema.ts`). The classified set says
 * what the platform records TODAY; this says what it has recorded. A route reclassified out
 * of the set leaves entries behind, and a filter built from the set alone would refuse a
 * value a customer can see in their own page.
 *
 * SCOPED, LIKE EVERY READ HERE — an unscoped `SELECT DISTINCT action` would tell a tenant
 * which actions OTHER tenants have taken, which is a smaller leak than a row and still a
 * leak. */
export async function auditActionsHeld(
  db: Db,
  environmentId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.environmentId, environmentId));
  return rows.map((r) => r.action);
}
