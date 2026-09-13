// Chapter 4.1's four numbers.
//
// M1  the analytical question's own cost, with its plan
// M2  the send path's p95 beside it and without it
// M3  the same question after the index that would fix it
// M4  the send path's p95 with that index in place, and what it costs to store
//
// M3 AND M4 RUN AGAINST A COPY AND THE COLUMN NEVER BECOMES A MIGRATION. A migration
// file enters `schema_migrations` and the numbering, and `gaps.md` 045-69 is what an
// identity scheme going wrong costs. What this publishes is numbers and an EXPLAIN.
import { spawn } from "node:child_process";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(REPO, "services", "api", "dist");
const client = require_(join(DIST, "db", "client.js"));

const QUERY_WINDOW_DAYS = 90;
const SENDS_PER_SECOND = 10; // DEFAULT_LIMITS.send is 600/min; this is the ceiling.
const LOOP_SECONDS = Number(process.env.MEASURE_SECONDS ?? 60);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const urlFor = (database) => {
  const u = new URL(process.env.DATABASE_URL ?? client.DEFAULT_DATABASE_URL);
  u.pathname = `/${database}`;
  return u.toString();
};

/** THE HARNESS SPAWNS `dist`, SO A STALE ONE MEASURES ANOTHER TAG.
 * 045-77 is the runtime form of that trap: a `dist` built at the tip against an older
 * tag's database gave 38 identical `42703 column … does not exist` errors that read
 * like a broken chain, and it cost a published conclusion before it was found. */
function refuseStaleDist() {
  const newest = (dir) => {
    let t = 0;
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!e.isFile()) continue;
      t = Math.max(t, statSync(join(e.parentPath ?? e.path, e.name)).mtimeMs);
    }
    return t;
  };
  const src = newest(join(REPO, "services", "api", "src"));
  const dist = newest(DIST);
  if (dist < src) {
    throw new Error(
      `services/api/dist is older than src (${new Date(dist).toISOString()} < ` +
        `${new Date(src).toISOString()}). Run \`pnpm build\` — the harness spawns dist.`,
    );
  }
}

/** The api, at PORT=0, against the database named. The port comes from the child's own
 * log line: nine hand-allocated port bands put a service inside another's range twice,
 * and the map was deleted rather than corrected. */
async function spawnApi(url) {
  const child = spawn("node", [join(DIST, "main.js")], {
    env: {
      ...process.env,
      DATABASE_URL: url,
      PORT: "0",
      RELAY_OUTBOX_RELAY: "off",
      RELAY_NOTIFICATION_RELAY: "off",
      RELAY_EVENT_CONSUMER: "off",
      RELAY_DELIVERY_RELAY: "off",
      RELAY_QUOTA_RELAY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  const port = await new Promise((res, rej) => {
    const t = setTimeout(
      () => rej(new Error(`no port in 60s:\n${buf.slice(-1200)}`)),
      60_000,
    );
    const scan = (d) => {
      buf += d.toString();
      const m = /(?:listening|port)\D{0,20}(\d{4,5})/i.exec(buf);
      if (m) {
        clearTimeout(t);
        res(Number(m[1]));
      }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    const ok = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
    if (ok) return { child, base };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGTERM");
  throw new Error("api never became healthy");
}

const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** THE LOOP MEASURES LATENCY, NOT THROUGHPUT, AND THE CEILING IS NOT A CHOICE.
 * `DEFAULT_LIMITS.send` is 600 per environment per minute and a REST send spends both
 * the send and rest budgets. Ten a second for sixty seconds is 600 samples — enough to
 * state a p95 and not enough to call the database busy. NFR-PRF-02 is a latency clause:
 * "REST write latency, excluding network, p95 < 150 ms". */
async function sendLoop(base, corpus, seconds) {
  const samples = [];
  const refusals = [];
  const deadline = Date.now() + seconds * 1000;
  let n = 0;
  while (Date.now() < deadline) {
    const at = Date.now();
    const t0 = process.hrtime.bigint();
    const r = await fetch(`${base}/v1/channels/${corpus.send_target.channel}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${corpus.credential}`,
      },
      body: JSON.stringify({
        text: `measure ${n}`,
        user: corpus.send_target.bot,
        attachments: [],
      }),
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // A LOOP THAT MEASURES REFUSALS IS MEASURING THE WRONG THING. A 429 is the rate
    // limiter, not the write path, and averaging it into a p95 would report the
    // limiter's speed as the database's.
    if (r.status === 201) samples.push(ms);
    else refusals.push({ status: r.status, body: (await r.text()).slice(0, 160) });
    n += 1;
    const wait = at + 1000 / SENDS_PER_SECOND - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }
  // A LOOP THAT ACCEPTED NOTHING MUST SAY SO RATHER THAN REPORT A PERCENTILE OF
  // NOTHING. The first version called `percentile([])` and died on `undefined.toFixed`,
  // which is a crash where the useful output is the refusal body.
  if (samples.length === 0) {
    throw new Error(
      `the send loop accepted 0 of ${n} sends; first refusals: ` +
        JSON.stringify(refusals.slice(0, 3)),
    );
  }
  return {
    sends: n,
    accepted: samples.length,
    refused: refusals.length,
    refusals: refusals.slice(0, 3),
    p50: +percentile(samples, 50).toFixed(1),
    p95: +percentile(samples, 95).toFixed(1),
    p99: +percentile(samples, 99).toFixed(1),
  };
}

/** FR-ANL-05 and FR-ANL-09's question, written against this schema for the first time.
 * `messages` carries no `environment_id` and nothing indexes `created_at`, so it is a
 * join and a scan — against a ClickHouse table that is `ORDER BY (environment_id, ts)`. */
const BASELINE_SQL = `
  SELECT date_trunc('day', m.created_at) AS day,
         count(*)                        AS messages,
         count(DISTINCT m.user_id)       AS active_users
  FROM messages m JOIN channels c ON c.id = m.channel_id
  WHERE c.environment_id = $1
    AND m.created_at >= now() - interval '${QUERY_WINDOW_DAYS} days'
  GROUP BY 1`;

/** The same question against the denormalised column. IT IS A DIFFERENT QUERY AND THE
 * chapter says so: a faster query that is also a different query proves less than it
 * looks like it proves. What the index buys is the join disappearing and the predicate
 * reaching `environment_id` directly. */
const COUNTERFACTUAL_SQL = `
  SELECT date_trunc('day', m.created_at) AS day,
         count(*)                        AS messages,
         count(DISTINCT m.user_id)       AS active_users
  FROM messages m
  WHERE m.environment_id = $1
    AND m.created_at >= now() - interval '${QUERY_WINDOW_DAYS} days'
  GROUP BY 1`;

async function runQuery(pool, sql, environmentId, runs = 3) {
  const times = [];
  let rows = 0;
  for (let i = 0; i < runs; i += 1) {
    const t0 = process.hrtime.bigint();
    const r = await pool.query(sql, [environmentId]);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    rows = r.rowCount;
  }
  const plan = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
    [environmentId],
  );
  return {
    runs,
    ms: times.map((t) => +t.toFixed(1)),
    best_ms: +Math.min(...times).toFixed(1),
    days_returned: rows,
    plan: plan.rows.map((r) => r["QUERY PLAN"]),
  };
}

const corpusOf = () => JSON.parse(readFileSync(arg("corpus", "corpus.json"), "utf8"));

async function main() {
  if (flag("drop-all")) {
    const admin = client.createPool();
    const { rows } = await admin.query(
      "select datname from pg_database where datname like 'relay_corpus%'",
    );
    for (const { datname } of rows) await admin.query(`drop database "${datname}"`);
    await admin.end();
    console.log(JSON.stringify({ dropped: rows.map((r) => r.datname) }, null, 2));
    return;
  }

  if (flag("query-only")) {
    // T029's lane comparison. NO SEND LOOP RUNS HERE — the lane is somebody else's
    // database — and the environment is NAMED rather than assumed, because the lane
    // holds tens of thousands of them at about ten messages each.
    const db = arg("db", "relay");
    process.env.DATABASE_URL = urlFor(db);
    const p = client.createPool();
    const env =
      arg("environment") ??
      (
        await p.query(`select c.environment_id id from messages m
                       join channels c on c.id = m.channel_id
                       group by 1 order by count(*) desc limit 1`)
      ).rows[0].id;
    const scope = await p.query(
      `select count(*)::int n from messages m join channels c on c.id = m.channel_id
       where c.environment_id = $1`,
      [env],
    );
    const q = await runQuery(p, BASELINE_SQL, env);
    await p.end();
    console.log(
      JSON.stringify(
        { database: db, environment: env, rows_in_environment: scope.rows[0].n, query: q },
        null,
        2,
      ),
    );
    return;
  }

  refuseStaleDist();
  const corpus = corpusOf();
  const phase = arg("phase", "baseline");
  const target =
    phase === "counterfactual" ? `${corpus.database}_cf` : corpus.database;

  if (phase === "counterfactual") {
    // A COPY, NOT A SECOND SEEDED CORPUS. Two corpora that differ by chance make the
    // four numbers incomparable, which would leave the chapter's central claim resting
    // on a difference nobody can attribute.
    const admin = client.createPool();
    await admin.query(`drop database if exists "${target}"`);
    await admin.query(`create database "${target}" template "${corpus.database}"`);
    await admin.end();
    process.env.DATABASE_URL = urlFor(target);
    const p = client.createPool();
    await p.query("alter table messages add column environment_id uuid");
    await p.query(
      `update messages m set environment_id = c.environment_id
       from channels c where c.id = m.channel_id`,
    );
    await p.query("create index on messages (environment_id, created_at)");
    await p.query("analyze messages");
    await p.end();
  }

  process.env.DATABASE_URL = urlFor(target);
  const pool = client.createPool();
  const sql = phase === "counterfactual" ? COUNTERFACTUAL_SQL : BASELINE_SQL;
  const env = corpus.subject_environment_id;

  const storage = (
    await pool.query(
      `select pg_size_pretty(pg_relation_size('messages')) table_size,
              pg_size_pretty(pg_indexes_size('messages')) index_size,
              pg_relation_size('messages') table_bytes,
              pg_indexes_size('messages') index_bytes`,
    )
  ).rows[0];

  const { child, base } = await spawnApi(urlFor(target));
  try {
    // WARM FIRST, AND MEASURE QUIET ON BOTH SIDES OF BUSY.
    //
    // The second version of this ran quiet then busy and reported the send path **7.9 ms
    // FASTER** beside 102 analytical queries than alone. That is not a neighbour effect
    // with the sign flipped; it is the first loop paying cold-cache costs the second did
    // not. The comparison confounded "beside a query" with "second".
    //
    // A warm-up the results discard, and a second quiet loop AFTER busy, make the
    // confound visible: if the two quiet loops disagree, the ordering is still carrying
    // the result and neither number means what it says.
    await sendLoop(base, corpus, Math.min(15, LOOP_SECONDS));
    await pool.query(sql, [env]);

    // M2a — the send path with nothing else running.
    const quiet = await sendLoop(base, corpus, LOOP_SECONDS);

    // M1 AND M2b — AND THE QUERY RUNS FOR THE WHOLE WINDOW, NOT ONCE.
    //
    // The first version ran it a single time beside a sixty-second loop. At ~600 ms
    // that is about 1% overlap: 6 of 599 sends had anything running beside them, and
    // the p95 came back 1.4 ms FASTER than quiet. **A measurement that covers 1% of the
    // window cannot show a neighbour effect**, so reporting "no effect" from it would
    // have been an assertion that could only have failed for somebody else's reason.
    //
    // The query now repeats until the loop finishes, which is what "beside" has to mean.
    let stop = false;
    const busyPromise = sendLoop(base, corpus, LOOP_SECONDS).finally(() => {
      stop = true;
    });
    const query = await runQuery(pool, sql, env);
    let queryRuns = 1;
    while (!stop) {
      await pool.query(sql, [env]);
      queryRuns += 1;
    }
    const busy = await busyPromise;
    busy.analytical_queries_running_alongside = queryRuns;

    // The control. Same conditions as M2a, taken after M2b.
    const quietAgain = await sendLoop(base, corpus, LOOP_SECONDS);

    console.log(
      JSON.stringify(
        {
          phase,
          database: target,
          environment: env,
          corpus: corpus.subject,
          storage,
          query,
          send_p95_quiet: quiet,
          send_p95_beside_query: busy,
          send_p95_quiet_again: quietAgain,
          // If the two quiet loops differ by more than the effect being claimed, the
          // ordering is carrying the result and the comparison says nothing.
          quiet_loops_agree_within_ms: +Math.abs(quiet.p95 - quietAgain.p95).toFixed(1),
          nfr_prf_02_ms: 150,
        },
        null,
        2,
      ),
    );
  } finally {
    child.kill("SIGTERM");
    await pool.end();
  }
}

await main();
process.exit(0);
