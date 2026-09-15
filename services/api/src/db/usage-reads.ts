import { sql } from "drizzle-orm";

import type { Db } from "./client";

// THE OPERATIONAL HALF OF FR-ANL-06's COMPARISON, AND IT LIVES HERE BECAUSE OF A LINT RULE
// THAT IS A CONSTITUTION CLAUSE.
//
// `eslint.config.mjs` restricts `drizzle-orm` to `services/api/src/db/**` — *"the query engine
// lives inside the repository layer only (constitution I, ADR-16)"*. Chapter 4.7's reconciler
// was written in `services/api/src/metering/` with its Postgres read inline and failed lint on
// the import, which is the rule doing exactly its job: the plan had placed the job in the api
// *because* the api owns the repository, and never noticed the wall between them.
//
// A NEW FILE RATHER THAN A METHOD ON `Repository`. That class is tenant-scoped around
// `this.environmentId` and this read takes the tenant as an argument; and `repository.ts`
// carries 24 titled fences in English and 23 in Vietnamese, both already stale, so every edit
// to it adds to a debt no gate reports. This file carries none.
//
// READ-ONLY. The reconciler compares and writes nothing.

export interface OperationalUsage {
  /** Absent when the tenant has no `usage_periods` row for the period at all — which is not
   *  the same as a row holding zero, and the reconciler reports the two differently. */
  messagesSent: number | null;
  connectionMinutes: number | null;
  /** A COUNT OF ROWS, not a stored total: `usage_active_users` is
   *  `(environment_id, period, user_id, first_seen_at)`, one row per user per period. So this
   *  is the only quantity whose comparison puts an EXACT count against `uniqMerge`'s
   *  approximate sketch, which is where 047-1's 0.51% lives. */
  activeUsers: number;
}

export async function operationalUsageFor(
  db: Db,
  environmentId: string,
  period: string,
): Promise<OperationalUsage> {
  // BOTH STATEMENTS NAME THE ENVIRONMENT. `usage_periods` and `usage_active_users` both carry
  // feature 030's sentinel guard, and the api's integration lane sets
  // `RELAY_HARNESS_BAIT: "on"` — unlike the gateway's, which carries none. A scoped statement
  // never reaches a sentinel row and never raises; an unscoped one does both.
  const periods = await db.execute(sql`
    select messages_sent, connection_minutes
      from usage_periods
     where environment_id = ${environmentId}::uuid and period = ${period}::date`);
  const active = await db.execute(sql`
    select count(*)::int as n
      from usage_active_users
     where environment_id = ${environmentId}::uuid and period = ${period}::date`);

  const row = periods.rows[0] as
    | { messages_sent: string | number; connection_minutes: string | number }
    | undefined;
  return {
    messagesSent: row === undefined ? null : Number(row.messages_sent),
    connectionMinutes: row === undefined ? null : Number(row.connection_minutes),
    activeUsers: Number((active.rows[0] as { n: number } | undefined)?.n ?? 0),
  };
}
