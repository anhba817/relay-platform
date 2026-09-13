#!/usr/bin/env node
// FR-ANL-05's daily question, asked of the analytical store.
//
// THE SAME QUESTION 4.1 ASKED POSTGRES, and it has to be the same or the comparison is
// between two questions rather than two stores. 4.1 ran:
//
//   SELECT date_trunc('day', m.created_at), count(*), count(DISTINCT m.user_id)
//   FROM messages m JOIN channels c ON c.id = m.channel_id
//   WHERE c.environment_id = $1 AND m.created_at >= now() - interval '90 days'
//   GROUP BY 1
//
// Here there is no join -- `environment_id` is on the row -- and `event = 'created'`
// stands in for "a message", because this table holds three rows per message and only one
// of them is a send. `count(DISTINCT user_id)` ignores NULLs in Postgres and `uniqExact`
// ignores them here, which is why the column is Nullable rather than a zero UUID.
const DB = "relay_analytics";
const PORT = process.env.RELAY_CLICKHOUSE_HTTP_PORT || "8123";
const HOST = process.env.RELAY_CLICKHOUSE_HOST || "localhost";
const USER = process.env.RELAY_CLICKHOUSE_USER || "relay";
const PASS = process.env.RELAY_CLICKHOUSE_PASSWORD || "relay";
const WINDOW_DAYS = 90;

async function post(sql, json = false) {
  const body = json ? `${sql} FORMAT JSON` : sql;
  const res = await fetch(`http://${HOST}:${PORT}/`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64") },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim().split("\n")[0]);
  return json ? JSON.parse(text) : text.trim();
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// THE ROLLUP'S READ CONTRACT IS `sum()` WITH `GROUP BY`, AND THAT IS NOT OPTIONAL.
// `daily_usage` holds one physical row per (environment_id, day) PER INSERT that touched
// it, until a background merge collapses them. The whole corpus arrives in one INSERT, so
// it lands at one row per key and a bare `SELECT messages` looks correct -- and three
// separate inserts of 1,000 rows measured 3 physical rows, a bare read of 1000, and a
// sum of 3000. **The number of rows per key is the number of inserts, not the number of
// events**, and a dashboard built against a quiet demo breaks on a busy day.
const rollupQuery = (env) => `
SELECT day,
       sum(messages)                 AS messages,
       uniqMerge(active_users_state) AS active_users
  FROM ${DB}.daily_usage
 WHERE environment_id = toUUID('${env}')
   AND day >= toDate(now() - INTERVAL ${WINDOW_DAYS} DAY)
 GROUP BY day
 ORDER BY day`;

// BOTH SIDES TAKE THE SAME WINDOW, ALWAYS. The rollup outlives the raw table: the view
// counts rows the TTL is about to delete, and it has no TTL of its own, so it keeps days
// `message_events` has already dropped. Unwindowed, this comparison would be between two
// populations and its difference would be mostly TTL -- handed to FR-009 as `uniq`'s
// approximation error, which is 0.51% at 70,000 distinct and small enough to vanish
// underneath it.
const compareExact = (env) => `
SELECT (SELECT uniqMerge(active_users_state) FROM ${DB}.daily_usage
         WHERE environment_id = toUUID('${env}')
           AND day >= toDate(now() - INTERVAL ${WINDOW_DAYS} DAY)) AS rollup_uniq,
       (SELECT uniqExact(user_id) FROM ${DB}.message_events
         WHERE environment_id = toUUID('${env}')
           AND ts >= toDateTime(toDate(now() - INTERVAL ${WINDOW_DAYS} DAY))
           AND event = 'created') AS raw_exact`;
// The raw side is DAY-ALIGNED here and not in `rawQuery`. A daily rollup's finest grain
// is a day, so it cannot answer a question whose window opens mid-morning -- comparing a
// timestamp window against it would charge the rollup for a boundary it cannot express.
// `rawQuery` keeps 4.1's timestamp form, because that comparison is against Postgres.

const rawQuery = (env) => `
SELECT toDate(ts)        AS day,
       count()           AS messages,
       uniqExact(user_id) AS active_users
  FROM ${DB}.message_events
 WHERE environment_id = toUUID('${env}')
   AND ts >= now() - INTERVAL ${WINDOW_DAYS} DAY
   AND event = 'created'
 GROUP BY day
 ORDER BY day`;

async function main() {
  let env = arg("--environment");
  if (!env) {
    // The busiest tenant, the same way 046 chose one -- so the two measurements are of
    // the same shape of tenant and not of whichever id happened to be typed.
    env = await post(
      `SELECT environment_id FROM ${DB}.message_events
        GROUP BY environment_id ORDER BY count() DESC LIMIT 1`,
    );
  }

  const mode = process.argv.includes("--rollup") ? "rollup"
    : process.argv.includes("--compare-exact") ? "compare-exact" : "raw";

  if (mode === "compare-exact") {
    const [rollup, exact] = (await post(`${compareExact(env)} FORMAT TSV`)).split("\t").map(Number);
    console.log(JSON.stringify({
      mode, environment_id: env, window_days: WINDOW_DAYS,
      rollup_uniqMerge: rollup, raw_uniqExact: exact,
      difference: rollup - exact,
      relative: `${(((rollup - exact) / exact) * 100).toFixed(4)}%`,
    }, null, 2));
    return;
  }

  const q = mode === "rollup" ? rollupQuery : rawQuery;

  // WARM FIRST, THEN MEASURE. 046 published a wrong number twice by comparing a cold run
  // against a warm one; the fix there was a warm-up and a second quiet loop, and the same
  // applies to a single query whose first read pulls marks off disk.
  await post(q(env));

  const t0 = Date.now();
  const out = await post(q(env), true);
  const wall = Date.now() - t0;

  // `EXPLAIN indexes = 1` IS THE ONLY HONEST INSTRUMENT FOR SKIPPING.
  // `ProfileEvents['SelectedParts']` returned 0 for this same query (R5) -- the obvious
  // instrument reports nothing, and reports it silently. At this size a full scan answers
  // fast enough to look like an ordered one, so the plan is the evidence, not the clock.
  const plan = await post(`EXPLAIN indexes = 1 ${q(env)}`);

  console.log(JSON.stringify({
    mode,
    environment_id: env,
    window_days: WINDOW_DAYS,
    days_returned: out.data.length,
    rows_read: out.statistics.rows_read,
    bytes_read: out.statistics.bytes_read,
    server_elapsed_ms: +(out.statistics.elapsed * 1000).toFixed(2),
    wall_ms: wall,
    total_messages: out.data.reduce((a, r) => a + Number(r.messages), 0),
  }, null, 2));
  console.log("\nEXPLAIN indexes = 1\n" + plan);
}

main().catch((err) => {
  process.stderr.write(`query failed: ${err.message}\n`);
  process.exit(1);
});
