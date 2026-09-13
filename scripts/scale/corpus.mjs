// A message corpus at a requested volume, for chapter 4.1's measurements.
//
// `seed.mjs` beside this file seeds users and channels for NFR-SCL-01 and writes no
// messages; the corpus behind this project's only published million-row figure was
// built once and thrown away (`specs/034-chapter-3-15/baseline.txt:153`). This is the
// one that stays.
//
// THE VOLUME VARIABLES ARE WHAT THE QUERY SCANS, NOT WHAT THE DATABASE HOLDS, and the
// difference is two predicates deep. The analytical query is
//
//   FROM messages m JOIN channels c ON c.id = m.channel_id
//   WHERE c.environment_id = $1 AND m.created_at >= now() - interval '90 days'
//
// so a corpus counted as a database total overstates by the neighbours, and one counted
// as an environment total overstates by the days outside the window. Both were found in
// analysis, one pass apart, two lines apart in the same table. `CORPUS_MESSAGES` is the
// count inside both.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(REPO, "services", "api", "dist");

/** The query's own window, in days. Not a knob: it is FR-ANL-08's clause and DR-09's TTL,
 * and a corpus sized against a different number would be sized against nothing. */
export const QUERY_WINDOW_DAYS = 90;

/** What each non-subject environment gets, as a fraction of the subject's rows. Enough
 * that the tenant predicate excludes something; not enough to triple the seed. */
export const NEIGHBOUR_SHARE = 0.1;

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return n;
};

const stamp = () =>
  new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

export function readConfig(env = process.env) {
  const cfg = {
    database: env.CORPUS_DATABASE || `relay_corpus_${stamp()}`,
    messages: num("CORPUS_MESSAGES", 1_000_000),
    channels: num("CORPUS_CHANNELS", 2_000),
    users: num("CORPUS_USERS", 5_000),
    membershipsPerUser: num("CORPUS_MEMBERSHIPS_PER_USER", 2),
    environments: num("CORPUS_ENVIRONMENTS", 3),
    days: num("CORPUS_DAYS", 120),
    nullSenderRatio: num("CORPUS_NULL_SENDER_RATIO", 0.01),
    // THE CORPUS HAS TO BE ABLE TO SHOW WHAT THE CHAPTER IS ABOUT. Without these four it
    // holds creations only, with no attachments and ASCII text — and three of chapter
    // 4.2's four column findings become invisible in it: every row is `created`, so the
    // event filter excludes nothing; `attachments` is never written, so JSONLength and
    // length cannot disagree; and `corpus <n>` is ASCII, where lengthUTF8 and length
    // agree exactly. Only the null-sender ratio survived a stock corpus.
    //
    // The defaults mirror the lane's own proportions at the time of writing — 3,201
    // edited, 4,056 deleted and 2,241 with attachments out of 303,885 messages — so a
    // corpus built with no environment set looks like the data the platform accumulated.
    editedRatio: num("CORPUS_EDITED_RATIO", 0.0105),
    deletedRatio: num("CORPUS_DELETED_RATIO", 0.0133),
    attachmentRatio: num("CORPUS_ATTACHMENT_RATIO", 0.0074),
    nonAsciiRatio: num("CORPUS_NON_ASCII_RATIO", 0.1),
  };
  // BOTH OF THESE REFUSE A CORPUS THAT TESTS ONLY ONE OF THE QUERY'S TWO PREDICATES, and
  // both bounds are strict. One environment leaves `WHERE c.environment_id = $1` nothing to
  // exclude; a span equal to the window leaves the date predicate nothing to exclude. A
  // corpus that satisfies a predicate vacuously measures its cost at zero and reports a
  // number anyway — which is the defect this chapter is about, arriving in its own harness.
  //
  // Refusing is the right error to make. An instrument's false negative is worse than its
  // false positive: a refusal costs somebody a flag, and an acceptance costs a published
  // figure that looks like a measurement of two predicates and is a measurement of one.
  if (cfg.environments < 2) {
    throw new Error(
      `CORPUS_ENVIRONMENTS (${cfg.environments}) must be at least 2, ` +
        `or the tenant predicate excludes nothing and its cost is measured as zero`,
    );
  }
  if (cfg.days <= QUERY_WINDOW_DAYS) {
    throw new Error(
      `CORPUS_DAYS (${cfg.days}) must exceed the query window (${QUERY_WINDOW_DAYS}), ` +
        `or the date predicate excludes nothing and its cost is measured as zero`,
    );
  }
  for (const [name, v] of [
    ["CORPUS_NULL_SENDER_RATIO", cfg.nullSenderRatio],
    ["CORPUS_EDITED_RATIO", cfg.editedRatio],
    ["CORPUS_DELETED_RATIO", cfg.deletedRatio],
    ["CORPUS_ATTACHMENT_RATIO", cfg.attachmentRatio],
    ["CORPUS_NON_ASCII_RATIO", cfg.nonAsciiRatio],
  ]) {
    if (v > 1) throw new Error(`${name} must be at most 1`);
  }
  // THE SAME ARGUMENT AS THE TWO ABOVE, ONE COLUMN OVER. A corpus where nothing is
  // edited or deleted makes `where event = 'created'` exclude nothing, so the rollup's
  // filter is measured at zero and reported as a number anyway. A corpus where nothing
  // carries an attachment makes `attachment_count` uniformly NULL, so the expression
  // this chapter exists to correct cannot be wrong in it.
  if (cfg.editedRatio + cfg.deletedRatio === 0) {
    throw new Error(
      "CORPUS_EDITED_RATIO and CORPUS_DELETED_RATIO cannot both be 0, or every row is " +
        "`created` and the rollup's event filter excludes nothing",
    );
  }
  if (cfg.attachmentRatio === 0) {
    throw new Error(
      "CORPUS_ATTACHMENT_RATIO must be above 0, or attachment_count is uniformly NULL " +
        "and JSONLength cannot be shown to differ from length",
    );
  }
  // THE NAME GOES INTO `create database "…"` AND NOTHING ELSE CAN ESCAPE IT. A probe
  // with a quote in it produced `unterminated quoted identifier` — harmless here, and
  // the wrong shape of harmless: the failure message then said a database was LEFT IN
  // PLACE that had never been created. Refusing the name makes both cases impossible.
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(cfg.database)) {
    throw new Error(
      `CORPUS_DATABASE (${cfg.database}) must match /^[a-z][a-z0-9_]{0,62}$/`,
    );
  }
  return cfg;
}

/** What the config implies, before a row is written.
 *
 * CEIL ON THE SUBJECT AND FLOOR ON EACH NEIGHBOUR, stated in the contract because the
 * three message counts only add up under that pair — `round` on the subject gives
 * 1,333,333 at the defaults and the total misses by one. */
export function planFor(cfg) {
  const subjectMessages = Math.ceil((cfg.messages * cfg.days) / QUERY_WINDOW_DAYS);
  const neighbours = cfg.environments - 1;
  const per = {
    inWindow: Math.floor(cfg.messages * NEIGHBOUR_SHARE),
    messages: Math.floor(subjectMessages * NEIGHBOUR_SHARE),
    channels: Math.floor(cfg.channels * NEIGHBOUR_SHARE),
    users: Math.floor(cfg.users * NEIGHBOUR_SHARE),
  };
  const totalUsers = cfg.users + neighbours * per.users;
  return {
    subject: {
      messages_in_window: cfg.messages,
      messages: subjectMessages,
      channels: cfg.channels,
      users: cfg.users,
    },
    neighbours,
    perNeighbour: per,
    totals: {
      messages: subjectMessages + neighbours * per.messages,
      channels: cfg.channels + neighbours * per.channels,
      users: totalUsers,
      // +1 for the bot, which belongs to the channel the send loop addresses.
      channel_members: totalUsers * cfg.membershipsPerUser + 1,
    },
  };
}

// ---------------------------------------------------------------------------
// The database. Everything above is arithmetic and testable without one.
// ---------------------------------------------------------------------------

const client = require_(join(DIST, "db", "client.js"));
const repo_ = require_(join(DIST, "db", "repository.js"));

/** The connection string for a named database on the same server as the default.
 *
 * The caller passes no `DATABASE_URL`. This script connects to the default database
 * only long enough to `CREATE DATABASE`, and points everything after at the one it
 * made — including the migration runner, which reads `DATABASE_URL` itself. */
function urlFor(database) {
  const base = new URL(process.env.DATABASE_URL ?? client.DEFAULT_DATABASE_URL);
  const lane = decodeURIComponent(base.pathname).replace(/^\//, "");
  base.pathname = `/${database}`;
  return { url: base.toString(), lane };
}

async function createDatabase(cfg) {
  const { url, lane } = urlFor(cfg.database);
  // ISOLATION. The lane's own database is the one thing this must never touch: a
  // million rows inside it would break every whole-table assertion 045-74 spent a
  // feature finding.
  if (cfg.database === lane) {
    throw new Error(
      `CORPUS_DATABASE (${cfg.database}) is the lane's own database; refusing`,
    );
  }
  const admin = client.createPool();
  try {
    const { rows } = await admin.query(
      "select 1 from pg_database where datname = $1",
      [cfg.database],
    );
    if (rows.length) {
      // IT IS NOT IDEMPOTENT AND DOES NOT PRETEND TO BE. Adding to a corpus silently
      // would make every number published against it unattributable.
      //
      // THE FIRST VERSION REFUSED BY CRASHING. It opened a second pool with
      // `require("pg")`, which does not resolve from `scripts/` — `pg` is a dependency
      // of `services/api`, not of the root — so the path that was supposed to print a
      // refusal printed `Cannot find module 'pg'` instead. It was reachable only by
      // running it, because nothing creates this database twice on a normal run.
      const before = process.env.DATABASE_URL;
      process.env.DATABASE_URL = url;
      const probe = client.createPool();
      const held = await probe
        .query("select count(*)::int n from messages")
        .then((r) => r.rows[0].n)
        .catch(() => 0);
      await probe.end();
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
      throw new Error(
        `${cfg.database} already exists and holds ${held} messages; refusing. ` +
          `Pass a different CORPUS_DATABASE, or drop it.`,
      );
    }
    await admin.query(`create database "${cfg.database}"`);
  } finally {
    await admin.end();
  }
  return url;
}

/** The platform's own migration runner, against the database just created.
 *
 * NO DDL IS WRITTEN HERE (FR-003b). A measurement is a measurement of this platform
 * only if the corpus carries the schema this platform ships — and the runner is
 * `dist`, so a stale build measures another tag (045-77). */
function migrate(url) {
  const r = spawnSync("node", [join(DIST, "db", "migrate.js")], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`migrate failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return (r.stdout || "").trim();
}

/** One environment's rows. The subject gets the full volumes; a neighbour gets a
 * tenth, which is what makes `WHERE c.environment_id = $1` exclude something.
 *
 * RAW SQL GOES THROUGH THE `pg` POOL, NOT DRIZZLE. `repository.js` does not re-export
 * drizzle's `sql`, and constitution I forbids importing drizzle outside `src/db` — the
 * query engine lives inside the repository layer and is never a handle handed out. */
async function fillEnvironment(db, pool, environmentId, n, cfg, endsAt) {
  const repo = new repo_.Repository(db, environmentId);
  const tag = environmentId.slice(0, 8);
  const users = [];
  for (let u = 0; u < n.users; u += 1) {
    users.push(await repo.createUser(`corpus-u-${tag}-${u}`));
  }
  const channels = [];
  for (let c = 0; c < n.channels; c += 1) {
    channels.push(await repo.createChannel(`corpus-c-${tag}-${c}`, "public", null));
  }
  let members = 0;
  for (const [ui, user] of users.entries()) {
    for (let m = 0; m < cfg.membershipsPerUser; m += 1) {
      await repo.addMember(channels[(ui + m) % channels.length].id, user.id);
      members += 1;
    }
  }

  // MESSAGES DO NOT GO THROUGH `sendMessage`. That path runs a transaction, an
  // idempotency check, a quota read and a sequence allocation per message; it is the
  // thing being measured, not the thing that should build a million rows. No outbox
  // row, no event, no usage counter: the corpus is data, not history.
  //
  // `sequence` IS ALLOCATED PER CHANNEL FROM 1 (DR-01) — `generate_series` per channel
  // makes that true by construction rather than by a counter somebody has to reset.
  // THE WINDOW HOLDS EXACTLY WHAT WAS ASKED FOR, AND A UNIFORM OFFSET CANNOT DO THAT.
  // The first version spread `created_at` uniformly over the whole span, so the count
  // inside the 90 days was binomial around three quarters — 999,786 against a requested
  // million, which is immaterial for comparability and still fails the floor as written.
  //
  // Placing the two segments separately makes it exact AND keeps the density uniform:
  // `inWindow` rows over 90 days and `outWindow` over the remaining 30 come to the same
  // rows-per-day, because `outWindow` is `inWindow * (days - 90) / 90` by construction.
  // A design in which the tolerance cannot arise beats one that states a tolerance.
  const ids = users.map((u) => u.id);
  const inTotal = n.inWindow;
  const outTotal = n.messages - n.inWindow;
  let written = 0;
  for (const [i, ch] of channels.entries()) {
    const inN = Math.floor(inTotal / channels.length) + (i < inTotal % channels.length ? 1 : 0);
    const outN = Math.floor(outTotal / channels.length) + (i < outTotal % channels.length ? 1 : 0);
    // `sequence` is per channel from 1 (DR-01): the in-window rows take 1..inN and the
    // older ones continue from there. The ordering of ids against time is not what the
    // analytical query reads, and DR-01 only requires uniqueness within the channel.
    // THE OFFSET IS AN INTERVAL MULTIPLIED BY A DOUBLE, NOT TEXT CONCATENATED AND CAST.
    // `(x || ' days')::interval` round-trips through text, and a small enough random
    // formats as scientific notation: the floor run died on
    //     invalid input syntax for type interval: "3.191957288484204e-05 days"
    // A 2,000-row smoke test never produced a value small enough to reach it. Multiplying
    // an interval stays numeric and has no text form to get wrong.
    let seqOffset = 0;
    if (inN > 0) {
      await pool.query(
        `insert into messages (id, channel_id, sequence, user_id, text, attachments,
                               metadata, created_at)
         select gen_random_uuid(), $1::uuid, s,
                case when random() < $2 then null
                     else ($3::uuid[])[1 + floor(random() * $4)::int] end,
       case when random() < $8 then 'corpus ' || s || ' — café 🌍'
                     else 'corpus ' || s end,
                case when random() < $9
                     then '[{"url":"https://example.test/a.png"},{"url":"https://example.test/b.png"}]'::jsonb
                     else null end,
                '{}'::jsonb,
                $5::timestamptz - random() * $6 * interval '1 day'
         from generate_series(1, $7) s`,
        [ch.id, cfg.nullSenderRatio, ids, ids.length, endsAt, QUERY_WINDOW_DAYS, inN,
         cfg.nonAsciiRatio, cfg.attachmentRatio],
      );
      seqOffset = inN;
    }
    if (outN > 0) {
      await pool.query(
        `insert into messages (id, channel_id, sequence, user_id, text, attachments,
                               metadata, created_at)
         select gen_random_uuid(), $1::uuid, $8 + s,
                case when random() < $2 then null
                     else ($3::uuid[])[1 + floor(random() * $4)::int] end,
       case when random() < $10 then 'corpus ' || s || ' — café 🌍'
                     else 'corpus ' || s end,
                case when random() < $11
                     then '[{"url":"https://example.test/a.png"},{"url":"https://example.test/b.png"}]'::jsonb
                     else null end,
                '{}'::jsonb,
                $5::timestamptz - ($6 + random() * $7) * interval '1 day'
         from generate_series(1, $9) s`,
        [ch.id, cfg.nullSenderRatio, ids, ids.length, endsAt, QUERY_WINDOW_DAYS,
         cfg.days - QUERY_WINDOW_DAYS, seqOffset, outN,
         cfg.nonAsciiRatio, cfg.attachmentRatio],
      );
    }
    written += inN + outN;
  }
  return {
    users: users.length,
    channels: channels.length,
    channelIds: channels.map((c) => c.id),
    members,
    messages: written,
  };
}

async function seed(cfg, plan) {
  const url = await createDatabase(cfg);
  const migrated = migrate(url);
  process.env.DATABASE_URL = url;
  const pool = client.createPool();
  const db = client.createDb(pool);
  const endsAt = new Date().toISOString();
  const n1 = async (text, values = []) => Number((await pool.query(text, values)).rows[0].n);

  // ONE ORGANISATION, ONE APPLICATION PER ENVIRONMENT — AND THE SCHEMA DECIDED THAT,
  // NOT THE PLAN. Every document said one organisation and one application holding
  // three environments. `unique (application_id, kind)` refuses it: an application has
  // at most one `development` and one `production`. The first run died on 23505,
  // `Key (application_id, kind)=(…, development) already exists`.
  //
  // So the tenant shape is one organisation with three applications, which is also
  // what the product means — a customer's apps, each with its environments. The
  // subject comes from `createEnvironment`, the function every Part 2 suite and the
  // e2e harness use to mint a tenant; the neighbours get their own applications under
  // the same organisation.
  const subject = await repo_.createEnvironment(db, { name: "corpus" });
  const orgId = (
    await pool.query(
      `select a.organisation_id from environments e
       join applications a on a.id = e.application_id where e.id = $1`,
      [subject.id],
    )
  ).rows[0].organisation_id;

  const environments = [subject.id];
  for (let e = 1; e < cfg.environments; e += 1) {
    const { rows } = await pool.query(
      `with app as (
         insert into applications (id, organisation_id, name)
         values (gen_random_uuid(), $1::uuid, $2) returning id)
       insert into environments (id, application_id, kind, signing_secret)
       select gen_random_uuid(), app.id, 'development', gen_random_uuid()::text
       from app returning id`,
      [orgId, `corpus-neighbour-${e}`],
    );
    environments.push(rows[0].id);
  }

  let subjectRows = null;
  for (const [i, envId] of environments.entries()) {
    const n =
      i === 0
        ? {
            users: cfg.users,
            channels: cfg.channels,
            messages: plan.subject.messages,
            inWindow: plan.subject.messages_in_window,
          }
        : plan.perNeighbour;
    const got = await fillEnvironment(db, pool, envId, n, cfg, endsAt);
    if (i === 0) subjectRows = got;
  }

  // The credential the send loop authenticates with, and the bot it sends as. An
  // application credential may send only as a bot (FR-MSG-13) — a corpus of people
  // alone is one no measurement can write to, which a 403 said before any document did.
  const key = await repo_.createApiKey(db, { environmentId: subject.id });
  const repo = new repo_.Repository(db, subject.id);
  const bot = await repo.upsertUser("corpus-bot", {
    kind: "bot",
    description: "the send loop's sender",
    display_name: "Corpus Bot",
  });
  const botId = bot.user?.id ?? bot.id;
  const sendChannel = subjectRows.channelIds[0];
  await repo.addMember(sendChannel, botId);

  // THE DENORMALISED COUNTERS THE WRITE PATH MAINTAINS, WHICH A BULK INSERT BYPASSES.
  // EDITS AND DELETIONS, BECAUSE A STORE OF EVENTS NEEDS MORE THAN ONE KIND OF EVENT.
  //
  // The order is the one the platform would have produced: edits are written while the
  // message still says something, deletions null the text afterwards. A message can be
  // both, and the pair is the interesting one — its creation length survives in the
  // edit's `prior_text` while its last edit's resulting length dies with the tombstone.
  //
  // `message_edits` PK is (message_id, edited_at), so the k rows are a minute apart, and
  // k = 1 lands exactly on `messages.edited_at` — the latest edit, which is what that
  // column means. Chapter 3.23 writes no edit row for a deletion: a tombstone has no
  // text to preserve, and this seeder does not invent one.
  await pool.query(
    `update messages
        set edited_at = created_at + (random() * 3600) * interval '1 second'
      where random() < $1`,
    [cfg.editedRatio],
  );
  //
  // THE EDIT COUNT IS PRECOMPUTED PER MESSAGE, AND THE OBVIOUS FORM DOES NOT WORK.
  // `cross join lateral generate_series(1, 1 + floor(random() * 3)::int)` evaluates the
  // volatile argument ONCE for the whole query, not once per row: the first run of this
  // seeder gave 864 edits over 288 messages — exactly three each, every one of them —
  // and a 10-row probe of the same shape returned 10 rows, exactly one each. **It picks
  // a constant at random per query, which reads as random if you run it once.**
  // Precomputing `k` in a subquery makes it per-row: the same 10-row probe returns 19.
  await pool.query(`
    insert into message_edits (message_id, edited_at, prior_text)
    select m.id,
           m.edited_at - ((g.k - 1) * interval '1 minute'),
           'corpus prior v' || g.k || ' ' || repeat('x', 10 + g.k * 7)
      from (select id, edited_at, 1 + floor(random() * 3)::int AS edits
              from messages where edited_at is not null) m
      cross join lateral generate_series(1, m.edits) g(k)`);
  await pool.query(
    `update messages
        set deleted_at = created_at + (random() * 7200) * interval '1 second', text = null
      where random() < $1`,
    [cfg.deletedRatio],
  );

  // `channels.last_sequence` is where the next message's sequence comes from, so a
  // corpus that wrote sequences 1..N and left the counter at 0 makes the api allocate 1
  // and collide on `(channel_id, sequence)`. Every send returned 500 `internal_error`
  // and the log line carried only the status — found by sending one message by hand.
  //
  // `last_activity_at` is the same shape: the channel listing orders by it, and a
  // corpus of a million messages whose channels all claim no activity would measure a
  // sort over a column that is uniformly null.
  //
  // This is the chapter's own subject one level down. A counter maintained on the write
  // path is cheap for the write and invisible to anything that writes around it.
  await pool.query(`
    update channels c
       set last_sequence = x.mx, last_activity_at = x.ts
      from (select channel_id, max(sequence) mx, max(created_at) ts
              from messages group by 1) x
     where x.channel_id = c.id`);

  // THE CORPUS IS DATA, NOT HISTORY — AND IT TOOK A COUNT TO MAKE THAT TRUE.
  // Messages bypass `sendMessage`, so they write no outbox row. `addMember` does not:
  // it publishes `channel.member_added` (FR-WHK-02), and the first floor run left
  // 12,001 outbox rows, exactly one per membership. Nothing drains them here — there is
  // no relay against a scratch database — so they would sit as bait in a corpus the
  // contract says holds none.
  //
  // They are cleared, and `created.outbox` REPORTS the count rather than the contract
  // asserting it. A zero from an instrument is a claim about the corpus only if the
  // instrument can be shown to have read it.
  await pool.query("delete from outbox");

  const inSubject = `from messages m join channels c on c.id = m.channel_id
                     where c.environment_id = $1`;
  const out = {
    database: cfg.database,
    subject_environment_id: subject.id,
    credential: key.credential,
    send_target: { channel: sendChannel, bot: "corpus-bot" },
    // EVERY NUMBER BELOW IS COUNTED FROM THE DATABASE, NOT DERIVED FROM THE REQUEST.
    // A measurement that quotes its parameters is quoting an intention.
    subject: {
      messages_in_window: await n1(
        `select count(*)::int n ${inSubject} and m.created_at >= $2::timestamptz - interval '90 days'`,
        [subject.id, endsAt],
      ),
      messages: await n1(`select count(*)::int n ${inSubject}`, [subject.id]),
      channels: await n1("select count(*)::int n from channels where environment_id = $1", [subject.id]),
      users: await n1("select count(*)::int n from users where environment_id = $1 and kind = 'person'", [subject.id]),
    },
    created: {
      organisations: await n1("select count(*)::int n from organisations"),
      applications: await n1("select count(*)::int n from applications"),
      environments: await n1("select count(*)::int n from environments"),
      users: await n1("select count(*)::int n from users where kind = 'person'"),
      bot_users: await n1("select count(*)::int n from users where kind = 'bot'"),
      channels: await n1("select count(*)::int n from channels"),
      // `members`, NOT `channel_members`. Every document in this feature named a table
      // that does not exist; `memberships` is a different one (humans in organisations).
      members: await n1("select count(*)::int n from members"),
      api_keys: await n1("select count(*)::int n from api_keys"),
      messages: await n1("select count(*)::int n from messages"),
      messages_null_sender: await n1("select count(*)::int n from messages where user_id is null"),
      // REPORTED, NOT ASSERTED. Each of these is a column expression chapter 4.2 gets
      // wrong in an obvious way, and a zero here means the corpus cannot show it.
      messages_edited: await n1("select count(*)::int n from messages where edited_at is not null"),
      message_edits: await n1("select count(*)::int n from message_edits"),
      messages_edited_twice_or_more: await n1(
        "select count(*)::int n from (select message_id from message_edits group by 1 having count(*) > 1) x",
      ),
      messages_deleted: await n1("select count(*)::int n from messages where deleted_at is not null"),
      messages_edited_and_deleted: await n1(
        "select count(*)::int n from messages where edited_at is not null and deleted_at is not null",
      ),
      messages_with_attachments: await n1("select count(*)::int n from messages where attachments is not null"),
      // octet_length is BYTES and length is CHARACTERS — the same distinction as
      // ClickHouse's length() against lengthUTF8(), asked of Postgres. A corpus where
      // this is 0 cannot show FR-EMJ-02's defect at all.
      messages_non_ascii: await n1(
        "select count(*)::int n from messages where text is not null and octet_length(text) <> length(text)",
      ),
      outbox: await n1("select count(*)::int n from outbox"),
      channels_with_last_sequence: await n1(
        "select count(*)::int n from channels where last_sequence > 0",
      ),
      usage_periods: await n1("select count(*)::int n from usage_periods"),
    },
    created_at_range: (
      await pool.query("select min(created_at) lo, max(created_at) hi from messages")
    ).rows[0],
    migrations: migrated,
  };
  await pool.end();
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = readConfig();
  const plan = planFor(cfg);
  const t0 = Date.now();
  try {
    const out = await seed(cfg, plan);
    console.log(JSON.stringify({ ...out, elapsed_ms: Date.now() - t0 }, null, 2));
  } catch (err) {
    // PARTIAL STATE IS LEFT IN PLACE AND NAMED. A half-built corpus that looks empty
    // is worse than one that says what it is: the next run's refusal reports how many
    // messages it found, and a database silently dropped on failure would take the
    // evidence with it.
    process.stderr.write(
      `\ncorpus FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s.\n` +
        `  database ${cfg.database} is LEFT IN PLACE and may hold partial rows.\n` +
        `  inspect it, or drop it with: node scripts/scale/measure.mjs --drop-all\n` +
        `  cause: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}
