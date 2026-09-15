import type { ClickHouse } from "./clickhouse.js";

// FR-ANL-05's four quantities, read from rollup rows and from nothing else.
//
// DR-10: "Materialised views shall maintain daily per-tenant rollups for metering, so billing
// never scans raw events." This is the read that clause is about, and before this chapter
// nothing in the platform performed it -- the only file that had ever asked FR-ANL-05's
// question of the analytical store was `analytics/query.mjs`, referenced by no script, no
// service and no config.
//
// IT GOES THROUGH `ClickHouse` RATHER THAN BESIDE IT. That interface was insert-and-count
// until this chapter; a read placed in this directory with its own `fetch` would open a
// second client against the same four environment variables and make "one client per
// service" a sentence rather than a property.

/** One tenant-day's metered totals. */
export interface DailyUsage {
  day: string;
  messages: number;
  activeUsers: number;
  connectionMinutes: number;
}

const DB = "relay_analytics";

/** FR-ANL-05 per tenant per day, over a closed period.
 *
 * `sum()` WITH `GROUP BY` IS THE CONTRACT, NOT A STYLE. `SummingMergeTree` holds one physical
 * row per key per insert until a background merge, so a bare `SELECT messages` returns one
 * row per insert -- 047 measured it answering `1000 1000 1000` where the truth was 3000. A
 * read that is correct only after somebody has run `OPTIMIZE` is right in a demo and wrong in
 * production.
 *
 * `uniqMerge`, NOT `sum`, for active users: the column is an aggregate state, and `uniq` is
 * approximate above roughly 60,000-65,000 distinct. Any figure published from it states the
 * corpus cardinality beside it.
 *
 * A DAY WITH NO ACTIVITY IS A MISSING ROW, NEVER A ROW OF ZEROS. A materialised view emits
 * nothing for a group that had no input, so the absence of a row is the absence of data --
 * not a measurement of zero. The caller fills gaps if it needs a dense series, and this
 * function does not pretend to. */
export async function dailyUsage(
  store: ClickHouse,
  environmentId: string,
  from: string,
  to: string,
): Promise<DailyUsage[]> {
  const rows = await store.query(
    `SELECT day,
            sum(messages)                 AS messages,
            uniqMerge(active_users_state) AS active_users,
            sum(connection_minutes)       AS connection_minutes
       FROM ${DB}.daily_usage_v2
      WHERE environment_id = toUUID('${environmentId}')
        AND day BETWEEN '${from}' AND '${to}'
      GROUP BY day
      ORDER BY day
      FORMAT TSV`,
  );
  return rows.map((r) => ({
    day: r[0] ?? "",
    messages: Number(r[1] ?? 0),
    activeUsers: Number(r[2] ?? 0),
    connectionMinutes: Number(r[3] ?? 0),
  }));
}

/** The stored message count: a BALANCE, where every other quantity is a flow.
 *
 * NO LOWER BOUND, AND THAT IS THE WHOLE DIFFERENCE. The column holds a day's delta -- +1 for
 * a creation, -1 for a deletion -- so the count of messages stored as of a day is the sum of
 * every delta up to and including it. A `BETWEEN` here would report the period's CHANGE in
 * stored messages, which is a different question that reads as a plausible wrong answer.
 *
 * DR-17 states the technique for the media analogue: "summing `media_events` deltas
 * (uploaded/deleted)". This is the same shape one table over. */
export async function storedMessages(
  store: ClickHouse,
  environmentId: string,
  asOf: string,
): Promise<number> {
  const rows = await store.query(
    `SELECT sum(stored_delta) FROM ${DB}.daily_usage_v2
      WHERE environment_id = toUUID('${environmentId}') AND day <= '${asOf}'
      FORMAT TSV`,
  );
  return Number(rows[0]?.[0] ?? 0);
}
