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
// The database work is T012 onward, and its imports arrive with it. Writing them here
// first cost two lint errors for symbols nothing used.

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
  if (cfg.nullSenderRatio > 1) throw new Error("CORPUS_NULL_SENDER_RATIO must be at most 1");
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

// Running it as a script prints the plan and exits; the database work is T012 onward.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = readConfig();
  console.log(JSON.stringify({ config: cfg, plan: planFor(cfg) }, null, 2));
}
