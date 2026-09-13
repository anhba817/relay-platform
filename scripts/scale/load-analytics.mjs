#!/usr/bin/env node
// Load a corpus into the analytical store, through ClickHouse rather than through here.
//
// NO EXPORT AND NO CLIENT. ClickHouse reads Postgres itself with the `postgresql()` table
// function, so nothing streams rows through this process and the lockfile gains nothing.
// This script builds one INSERT and prints what the table holds afterwards.
//
// THE DATABASE COMES FROM THE CORPUS HANDLE AND THERE IS NO DEFAULT. `corpus.mjs` builds
// `relay_corpus_<timestamp>` and refuses to be pointed at `relay` -- the lane's own
// database -- so defaulting to `relay` here would read the one database the seeder exists
// to keep out of the way, and every figure would be about the wrong rows.
import { readFileSync } from "node:fs";

const DB = "relay_analytics";
const PORT = process.env.RELAY_CLICKHOUSE_HTTP_PORT || "8123";
const HOST = process.env.RELAY_CLICKHOUSE_HOST || "localhost";
const USER = process.env.RELAY_CLICKHOUSE_USER || "relay";
const PASS = process.env.RELAY_CLICKHOUSE_PASSWORD || "relay";
const PG_HOST = process.env.RELAY_PG_INTERNAL || "postgres:5432";
const PG_USER = process.env.POSTGRES_USER || "relay";
const PG_PASS = process.env.POSTGRES_PASSWORD || "relay";

async function run(sql) {
  const res = await fetch(`http://${HOST}:${PORT}/`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64") },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim().split("\n")[0]);
  return text.trim();
}

function corpusDatabase(argv) {
  const i = argv.indexOf("--corpus");
  if (i < 0 || !argv[i + 1]) {
    throw new Error(
      "--corpus <corpus.json> is required. The database is the one corpus.mjs reports; " +
        "there is no default, because the only plausible default is the lane.",
    );
  }
  const handle = JSON.parse(readFileSync(argv[i + 1], "utf8"));
  if (!handle.database) throw new Error(`${argv[i + 1]} names no database`);
  if (handle.database === "relay") {
    throw new Error("refusing to load the lane's own database; build a corpus first");
  }
  return handle.database;
}

const main = async () => {
  const database = corpusDatabase(process.argv);
  const pg = (table) =>
    `postgresql('${PG_HOST}', '${database}', '${table}', '${PG_USER}', '${PG_PASS}')`;

  // THREE ROWS PER MESSAGE, NOT ONE, because SAD 6.2's `event` column is
  // created|edited|deleted and `daily_usage` filters on it. A load that labels everything
  // `created` inflates FR-ANL-05's messages-sent by every deletion.
  //
  // AND `text_length` IS A DIFFERENT EXPRESSION ON EACH OF THE THREE.
  //
  //   created   the text as SENT -- which is the EARLIEST edit's prior_text if the
  //             message was ever edited, and messages.text if it was not
  //   edited    the text AFTER that edit -- which `message_edits` does not hold, because
  //             the table records what a message used to say. It is the NEXT edit's
  //             prior_text, or messages.text for the last edit
  //   deleted   nothing was written, so NULL
  //
  // Both lookups use a COUNT as the "is there one" test, never `prior_text != ''`.
  // `prior_text` is NOT NULL in Postgres and arrives as a non-nullable String, so a
  // LEFT JOIN with no match fills it with the EMPTY STRING rather than NULL -- and an
  // empty-string sentinel is right about a corpus that happens to have no empty prior
  // text, and wrong about the rule.
  const sql = `
INSERT INTO ${DB}.message_events
  (environment_id, channel_id, user_id, ts, event, text_length, attachment_count,
   delivery_latency_ms)
SELECT c.environment_id, m.channel_id, m.user_id, m.created_at, 'created',
       lengthUTF8(if(fe.n > 0, fe.first_prior, m.text)),
       JSONLength(m.attachments),
       CAST(NULL AS Nullable(UInt32))
  FROM ${pg("messages")} m
 INNER JOIN ${pg("channels")} c ON c.id = m.channel_id
  LEFT JOIN (SELECT message_id, argMin(prior_text, edited_at) AS first_prior, count() AS n
               FROM ${pg("message_edits")} GROUP BY message_id) fe ON fe.message_id = m.id
UNION ALL
SELECT c.environment_id, m.channel_id, m.user_id, e.edited_at, 'edited',
       lengthUTF8(if(e.next_n > 0, e.next_prior, m.text)),
       JSONLength(m.attachments),
       CAST(NULL AS Nullable(UInt32))
  FROM (SELECT message_id, edited_at,
               any(prior_text) OVER w AS next_prior,
               count()          OVER w AS next_n
          FROM ${pg("message_edits")}
        WINDOW w AS (PARTITION BY message_id ORDER BY edited_at
                     ROWS BETWEEN 1 FOLLOWING AND 1 FOLLOWING)) e
 INNER JOIN ${pg("messages")} m ON m.id = e.message_id
 INNER JOIN ${pg("channels")} c ON c.id = m.channel_id
UNION ALL
SELECT c.environment_id, m.channel_id, m.user_id, m.deleted_at, 'deleted',
       CAST(NULL AS Nullable(UInt32)),
       JSONLength(m.attachments),
       CAST(NULL AS Nullable(UInt32))
  FROM ${pg("messages")} m
 INNER JOIN ${pg("channels")} c ON c.id = m.channel_id
 WHERE m.deleted_at IS NOT NULL`;

  const t0 = Date.now();
  await run(sql);
  const elapsed = Date.now() - t0;

  // WHAT THE TABLE HOLDS, NOT WHAT WAS SENT -- AND "HOLDS" IS A MOVING TARGET.
  //
  // The TTL was measured at small scale removing rows AT INSERT: 120,000 over 120 days
  // became 90,000 with no error. That is true of an insert that lands in ONE part. This
  // load writes nine, and only some of them were TTL-processed on the way in: straight
  // after the INSERT the table held 1,388,152 rows over 121 DAYS with 147,066 already
  // expired and still present. The rest goes at a background merge, on ClickHouse's
  // schedule rather than yours.
  //
  // So the count immediately after a load is a MOMENT, not a steady state, and a chapter
  // that measured there would publish a number that shrinks on its own overnight. The
  // merge is forced here and BOTH counts are reported -- the difference between them is
  // the part of the TTL that had not happened yet.
  const sent = Number(
    await run(`SELECT (SELECT count() FROM ${pg("messages")})
                    + (SELECT count() FROM ${pg("message_edits")})
                    + (SELECT count() FROM ${pg("messages")} WHERE deleted_at IS NOT NULL)`),
  );
  const atInsert = (
    await run(`SELECT count(), uniqExact(toDate(ts)),
                      countIf(ts < now() - INTERVAL 90 DAY)
                 FROM ${DB}.message_events FORMAT TSV`)
  ).split("\t").map(Number);

  await run(`OPTIMIZE TABLE ${DB}.message_events FINAL`);

  const [held, days, nullCreated, nullEdited, nullAttach] = (
    await run(`SELECT count(), uniqExact(toDate(ts)),
                      countIf(event = 'created' AND text_length IS NULL),
                      countIf(event = 'edited'  AND text_length IS NULL),
                      countIf(attachment_count IS NULL)
                 FROM ${DB}.message_events FORMAT TSV`)
  ).split("\t").map(Number);

  console.log(JSON.stringify({
    database,
    elapsed_ms: elapsed,
    events_sent: sent,
    at_insert: { rows: atInsert[0], days: atInsert[1], expired_still_present: atInsert[2] },
    after_merge: { rows: held, days },
    removed_by_ttl: sent - held,
    removed_late: atInsert[0] - held,
    distinct_days_held: days,
    text_length_null: { created: nullCreated, edited: nullEdited },
    attachment_count_null: nullAttach,
  }, null, 2));
};

main().catch((err) => {
  process.stderr.write(`load-analytics failed: ${err.message}\n`);
  process.exit(1);
});
