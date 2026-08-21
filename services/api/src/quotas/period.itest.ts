import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import { createEnvironment } from "../db/repository";
import { usagePeriods } from "../db/schema";
import { periodOf } from "./period";

// T011a — THE ROUND TRIP, BEFORE ANYTHING DEPENDS ON IT.
//
// `period` is this project's first `date` column, against 28 `timestamp` ones,
// and it is half the primary key of `usage_periods` and a third of
// `usage_active_users`'s. Drizzle's `date` takes a mode; in its default mode it
// reads and writes `YYYY-MM-DD` strings, which is what `periodOf` returns.
//
// The failure this guards against is not a type error. A writer and a reader that
// disagree about the mode produce a lookup that FINDS NOTHING — a row inserted
// under one representation and searched for under another — and the symptom is a
// usage count that silently starts from zero. So the round trip is proved here
// rather than assumed in a comment (research R7a).

describe("the period column round-trips the value the period function produces", () => {
  let pool: ReturnType<typeof createPool>;
  let db: Db;
  let environmentId: string;

  beforeAll(async () => {
    pool = createPool();
    await migrate(pool);
    db = createDb(pool);
    const env = await createEnvironment(db, { name: "period-roundtrip" });
    environmentId = env.id;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it("inserts under the function's value and finds the row by that same value", async () => {
    const period = periodOf(new Date("2026-08-21T13:45:09.123Z"));
    expect(period).toBe("2026-08-01");

    await db.insert(usagePeriods).values({ environmentId, period });

    const rows = await db
      .select()
      .from(usagePeriods)
      // The whole primary key, which is the point: a lookup is the key, not a
      // predicate over a range.
      .where(
        and(
          eq(usagePeriods.environmentId, environmentId),
          eq(usagePeriods.period, period),
        ),
      );

    expect(rows).toHaveLength(1);
    // AND IT COMES BACK AS THE SAME STRING. If drizzle handed back a `Date` here
    // the next comparison in the send path would be against an object, and the
    // key lookup above would be the last thing that worked.
    expect(rows[0]!.period).toBe("2026-08-01");
    expect(typeof rows[0]!.period).toBe("string");
    expect(rows[0]!.messagesSent).toBe(0);
    expect(typeof rows[0]!.messagesSent).toBe("number");
  }, 30_000);

  it("keeps two months of one environment as two rows", async () => {
    const august = periodOf(new Date("2026-08-15T00:00:00.000Z"));
    const september = periodOf(new Date("2026-09-15T00:00:00.000Z"));
    await db.insert(usagePeriods).values({ environmentId, period: september });

    const rows = await db
      .select()
      .from(usagePeriods)
      .where(eq(usagePeriods.environmentId, environmentId));
    const periods = rows.map((r) => r.period).sort();
    expect(periods).toEqual([august, september]);
  }, 30_000);
});
