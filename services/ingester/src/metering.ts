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
  // NO FALLBACKS, AND THAT IS A DESIGN RATHER THAN AN OVERSIGHT. `?? ""` and `?? 0` on each
  // column looked defensive and measured 50% branches: the SELECT above names four columns,
  // so the absent arm cannot arise through the running query and no test can reach it. A
  // branch that cannot go both ways is a branch that is never checked -- 4.5 reached
  // 100/100/100/100 by deleting one, and this is the same move.
  return rows.map((r) => ({
    day: String(r[0]),
    messages: Number(r[1]),
    activeUsers: Number(r[2]),
    connectionMinutes: Number(r[3]),
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
  // NO EMPTY CHECK, BECAUSE THE EMPTY CASE DOES NOT EXIST. A first version guarded
  // `rows.length === 0` and carried a comment claiming a test drove both arms; it did not.
  // **A bare aggregate with no GROUP BY always returns exactly one row** -- asked of the
  // server directly, `sum()` over a tenant with nothing stored answers `0`, not an empty
  // result. The guard was unreachable and measured as half this file's branches.
  //
  // `flat()[0]` rather than `rows[0]?.[0]`: the optional chain is a branch too, and the
  // same one. A tenant with no rows would give NaN here if the server could produce one,
  // and it cannot.
  return Number(rows.flat()[0]);
}

/** FR-MED-12's level: the bytes a tenant is storing as of a day (chapter 4.16).
 *
 * **DR-17's TECHNIQUE, AND `storedMessages` ABOVE IS THE SHAPE.** *"A daily rollup
 * summing `media_events` deltas (uploaded/deleted)"* — the same accumulation one table
 * over, with two of that function's details copied deliberately: no empty-result guard,
 * because a bare aggregate with no `GROUP BY` always returns exactly one row, and
 * `flat()[0]` rather than `rows[0]?.[0]`, because the optional chain is a branch too.
 *
 * **AND THE ANSWER IS SHORT BY WHATEVER THE TTL REMOVED.** This sums from the beginning
 * of time, and `daily_usage_billing` carries `TTL toDateTime(day) + toIntervalMonth(25)`
 * — so a level older than the retention horizon is understated by exactly the deltas
 * that were deleted, permanently, with nothing in the system able to notice.
 *
 * `storedMessages` has the same defect and has never shown it, because `message_events`
 * holds 0 rows and has no producer. **This is the first reader of this shape that will
 * carry live data**, which is why SRS 1.23 bounds FR-MED-12 at the horizon and names
 * DR-17's inventory as what re-bases a truncated sum: the object store holds the level
 * directly, so the reconciliation can restate it. */
export async function storedBytes(
  store: ClickHouse,
  environmentId: string,
  asOf: string,
): Promise<number> {
  const rows = await store.query(
    `SELECT sum(stored_bytes_delta) FROM ${DB}.daily_usage_billing
      WHERE environment_id = toUUID('${environmentId}') AND day <= '${asOf}'
      FORMAT TSV`,
  );
  return Number(rows.flat()[0]);
}

/** FR-009's counts: how many objects a tenant uploaded on a day, by kind (chapter 4.16).
 *
 * **THIS EXISTS BECAUSE 4.6's FINDING WOULD OTHERWISE HAVE HAPPENED AGAIN, ONE MOVEMENT
 * LATER.** That chapter is called *"the rollup nobody read"*: it found a rollup that had
 * existed for two chapters, satisfied its clause, and was read by nothing — `grep` gave a
 * comment and a file referenced by no script, service or config. `uploads_by_kind` was in
 * exactly that state when this function was written: one writer (`0018`), no reader
 * outside a test. A clause that says the platform MUST count something is not discharged
 * by a column that holds the count.
 *
 * A DAY RATHER THAN A BALANCE, WHICH IS THE OPPOSITE OF `storedBytes` ABOVE AND ON
 * PURPOSE. Uploads are a FLOW — *"per tenant per day"* — so the window is closed at both
 * ends, where a stored level is a stock and has no lower bound. The two live in the same
 * `SELECT` in `0018` and the mistake of reading one the other's way is the specific thing
 * FR-010 exists to prevent.
 *
 * `sumMap` AND NOT A BARE `SELECT`, for `dailyUsage`'s reason at one more remove. The
 * column is `SimpleAggregateFunction(sumMap, …)` on a `SummingMergeTree`, so an unmerged
 * table answers one map per insert; measured in phase 2, a plain `Map` in this position
 * does not merge at all and keeps the first row's value.
 *
 * A KIND WITH NO UPLOADS IS ABSENT FROM THE MAP, NOT PRESENT AS ZERO — `dailyUsage`'s
 * *"a day with no activity is a missing row, never a row of zeros"*, one level down. The
 * caller fills the vocabulary if it needs a dense record, and this does not pretend to. */
export async function uploadsByKind(
  store: ClickHouse,
  environmentId: string,
  from: string,
  to: string,
): Promise<Record<string, number>> {
  const rows = await store.query(
    `SELECT sumMap(uploads_by_kind) FROM ${DB}.daily_usage_billing
      WHERE environment_id = toUUID('${environmentId}') AND day BETWEEN '${from}' AND '${to}'
      FORMAT TSV`,
  );
  return parseKindMap(rows.flat()[0]);
}

/** ClickHouse's TSV form for a `Map`, measured: `{'audio':14,'image':155,'video':2}` —
 *  one line, single-quoted keys, unquoted values. **Not JSON**, and the difference is not
 *  cosmetic: the first version of this read asked for `FORMAT JSONCompact`, whose keys are
 *  double-quoted and whose body is a multi-line envelope this client's tab-splitter would
 *  shred. The regex below would have matched nothing in it and returned **`{}`** — a
 *  silently empty answer from a tenant with uploads, which is the shape of wrong this
 *  project files against itself. The format was then asked of the server rather than
 *  assumed.
 *
 *  PARSED RATHER THAN RE-SHAPED IN SQL, because the alternative — `arrayJoin` into rows —
 *  turns one read into a shape every caller has to reassemble. */
function parseKindMap(value: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of (value ?? "").matchAll(/'([^']+)':(\d+)/g))
    out[m[1]!] = Number(m[2]);
  return out;
}
