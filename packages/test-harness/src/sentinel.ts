import { createHash } from "node:crypto";

// The sentinel: rows that exist only to be taken (feature 030).
//
// ONE PER TEST FILE, not one shared. Files execute in parallel — no integration
// config overrides `fileParallelism` — so a shared sentinel would mean one file's
// planting deleting rows another file is mid-test against. Per-file planting and a
// shared sentinel are incompatible, and the plan had both until research R12
// (FR-023).
//
// The ids are derived from the file's path, so they are stable across runs and
// unique across files, and a developer reading a failure can tell which file owns
// the rows that were taken.

/** How much bait to plant, per kind.
 *
 * DOUBLE THE LARGEST DEFAULT BATCH in the codebase, so a caller who omits a bound
 * reaches bait before reaching its own rows — which is the whole mechanism.
 *
 * The number is declared here rather than imported, because none of the product's
 * three `BATCH_SIZE` constants is exported and importing `outbox/relay.ts` would
 * drag its whole dependency graph into a setup file. That trade is only acceptable
 * because `bait-size.test.ts` reads those three files and fails if any of them
 * rises past this bound: a literal that goes stale silently is the thing research
 * R7 warned about, and a literal guarded by a test is not silent (FR-002). */
export const MAX_PRODUCT_BATCH = 100;
export const BAIT_ROWS = MAX_PRODUCT_BATCH * 2;

/** The product files whose batch defaults this bound has to dominate. Read by
 * `bait-size.test.ts`; listed here so the two cannot drift apart. */
export const BATCH_SOURCES = [
  "services/api/src/outbox/relay.ts",
] as const;

// NOT `db/repository.ts`, AND THE REASON IS THE INTERESTING ONE. Its claim-and-
// publish takes `limit: number` with no default, and so does its message page — a
// caller cannot omit the bound, so there is no default for the bait to dominate.
// A required parameter beats a defaulted one here for the same reason a design in
// which a case cannot arise beats a branch that handles it: the branch is the thing
// that rots. Add a default to either and this list has to grow, which
// `bait-size.test.ts` will not tell you — it checks that every file NAMED here has
// a default, not that every file WITH one is named. That direction needs a reader.

export interface Sentinel {
  /** The test file that owns these rows, as a repository-relative path. */
  owner: string;
  organisationId: string;
  humanId: string;
  applicationId: string;
  environmentId: string;
  /** GUARD BAIT, not drain bait. A trigger sits on `users` and `channels`, and its
   * WHEN clause tests `__is_sentinel(OLD.environment_id)` — which needs a row IN the
   * table to have anything to test. Without these two the triggers install, report
   * as installed, and can never match. See `sentinel.sql`. */
  userId: string;
  channelId: string;
  /** THE QUOTA CHAPTER'S BAIT, and its own three. `usage_periods`,
   * `usage_active_users` and `quota_notifications` all carry `environment_id` and all
   * three joined the trigger array, so all three need a row for the WHEN clause to
   * have something to test.
   *
   * `quotaPeriod` is a FIXED month rather than the current one, because two of the
   * three tables are keyed on it and a bait row whose key moved at midnight on the
   * first would be a fixture that fails one day in thirty. It is far enough in the
   * past that no product code will ever write the same key. */
  quotaPeriod: string;
  quotaNotificationId: string;
  /** `__sentinel__:<owner>`, on every row, so a failure says whose it is. */
  name: string;
}

/** A v4-shaped uuid derived from a string. Deterministic, so a file's sentinel is
 * the same on every run and the delete-then-insert in `plant` is exact. */
function uuidFrom(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  // Set the version and variant nibbles so the value is a well-formed uuid; the
  // remaining bits are the hash. Postgres does not care, but a human comparing
  // this against `data-model.md` should not have to wonder whether it is one.
  const v = "4" + h.slice(13, 16);
  const r = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${r}-${h.slice(20, 32)}`;
}

export function sentinelFor(owner: string): Sentinel {
  const id = (part: string) => uuidFrom(`relay-sentinel/${owner}/${part}`);
  return {
    owner,
    organisationId: id("organisation"),
    humanId: id("human"),
    applicationId: id("application"),
    environmentId: id("environment"),
    userId: id("user"),
    channelId: id("channel"),
    quotaPeriod: "1999-01-01",
    quotaNotificationId: id("quota-notification"),
    name: `__sentinel__:${owner}`,
  };
}

/** The shared sentinel this feature does NOT have, kept as a named export so a
 * reader looking for one finds this comment instead. */
export const SENTINEL = {
  note:
    "There is no shared sentinel. Use sentinelFor(<test file path>) — research R12.",
} as const;

/** Plant this file's bait, replacing whatever is there.
 *
 * IDEMPOTENT BY DELETE-THEN-INSERT rather than `ON CONFLICT`, because three of the
 * four baits are consumable and a re-insert has to restore the *count* as well as
 * the rows. The environment id makes the delete exact, so the seeder cannot become
 * the accumulation it exists to simulate (FR-003).
 *
 * THE CLIENT IS THE CALLER'S PROBLEM, and that is the point. Deleting a sentinel
 * row is exactly what the trigger forbids, so planting needs the exemption — and a
 * connection carrying the exemption must never reach a test, or that test runs
 * unguarded. `setup.ts` opens a dedicated client, passes it here, and closes it
 * before the first test (FR-024, research R12).
 *
 * TWO KINDS, AND THEY ARE NOT THE SAME MECHANISM. Confusing them is how a table
 * ends up named as guarded and watched by nothing:
 *
 *   GUARD BAIT — a row the trigger PROTECTS. One per table named in
 *   `sentinel.sql`'s array, because the WHEN clause has nothing to test without
 *   one. A `users` row and a `channels` row, at this chapter.
 *
 *   DRAIN BAIT — a row a global operation would CLAIM, so that an unscoped sweep
 *   takes something belonging to a test. One per global operation in the codebase:
 *
 *     unpublished outbox rows  ->  drainOutbox
 *
 * ONE GLOBAL OPERATION EXISTS AT THIS CHAPTER, so there is one drain bait, and the
 * list grows with the code rather than ahead of it. Bait planted for an operation
 * nobody has written yet is bait nothing can take — which is indistinguishable, in
 * a passing suite, from bait that works. */
export async function plant(
  client: { query(sql: string, values?: unknown[]): Promise<unknown> },
  s: Sentinel,
): Promise<void> {
  const q = (sql: string, values?: unknown[]) => client.query(sql, values);

  // Children before parents, so the deletes do not trip a foreign key — and
  // `read_positions` references BOTH `channels` and `users`, which is why the note
  // the instruments chapter left here said the order was not arbitrary.
  // The subject the plant below writes, not the one it used to: a cleanup keyed on
  // a stale subject leaves every row it was meant to remove.
  await q(`DELETE FROM outbox         WHERE subject = $1`, [`events.${s.name}.bait`]);
  await q(`DELETE FROM read_positions WHERE environment_id = $1`, [s.environmentId]);
  // The quota chapter's three, and they come before `users` for the reason the note
  // above gives: `usage_active_users` references it.
  await q(`DELETE FROM quota_notifications WHERE environment_id = $1`, [s.environmentId]);
  await q(`DELETE FROM usage_active_users  WHERE environment_id = $1`, [s.environmentId]);
  await q(`DELETE FROM usage_periods       WHERE environment_id = $1`, [s.environmentId]);
  await q(`DELETE FROM channels       WHERE environment_id = $1`, [s.environmentId]);
  await q(`DELETE FROM users          WHERE environment_id = $1`, [s.environmentId]);

  // Register before inserting bait: the trigger's WHEN clause tests membership,
  // so an unregistered sentinel is unguarded bait.
  await q(
    `INSERT INTO __sentinel_environments (environment_id, owner) VALUES ($1, $2)
     ON CONFLICT (environment_id) DO UPDATE SET owner = EXCLUDED.owner`,
    [s.environmentId, s.owner],
  );
  await q(
    `INSERT INTO organisations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [s.organisationId, s.name],
  );
  // provider must be 'github' or 'google' (humans_provider_check), and the email
  // is NULL on purpose — see above.
  await q(
    `INSERT INTO humans (id, provider, provider_account_id, email)
     VALUES ($1, 'github', $2, NULL) ON CONFLICT (id) DO NOTHING`,
    [s.humanId, s.name],
  );
  await q(
    `INSERT INTO memberships (organisation_id, human_id, role)
     VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
    [s.organisationId, s.humanId],
  );
  await q(
    `INSERT INTO applications (id, organisation_id, name)
     VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [s.applicationId, s.organisationId, s.name],
  );
  // kind must be 'development' or 'production' (environments_kind_check).
  await q(
    `INSERT INTO environments (id, application_id, kind, signing_secret)
     VALUES ($1, $2, 'development', $3) ON CONFLICT (id) DO NOTHING`,
    [s.environmentId, s.applicationId, `sentinel-not-a-secret-${s.environmentId}`],
  );

  // GUARD BAIT. One row in each table `sentinel.sql` names, so the trigger's WHEN
  // clause has a sentinel `environment_id` to match. These are not consumable — no
  // global operation claims them — and the count does not matter; what matters is
  // that the row EXISTS, because a trigger over a table holding no sentinel row is
  // a no-op that looks exactly like a trigger doing its job.
  //
  // `type` must be 'public' or 'private' (channels_type_check), and both tables are
  // unique on (environment_id, external_id) — read off the live schema, not guessed.
  await q(
    `INSERT INTO users (id, environment_id, external_id, display_name)
     VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING`,
    [s.userId, s.environmentId, s.name],
  );
  await q(
    `INSERT INTO channels (id, environment_id, external_id, type, name)
     VALUES ($1, $2, $3, 'private', $3) ON CONFLICT (id) DO NOTHING`,
    [s.channelId, s.environmentId, s.name],
  );
  // THIS CHAPTER'S GUARD BAIT. `read_positions` joined the trigger array in
  // `sentinel.sql`, and a name in that array with no row behind it installs a trigger
  // that can never match — which reads, in every report, exactly like protection.
  //
  // It reuses the user and channel above rather than minting a third id: the row only
  // has to EXIST for the WHEN clause to have something to test, and one keyed on a
  // pair the sentinel already owns is one fewer id to clean up.
  await q(
    `INSERT INTO read_positions (environment_id, channel_id, user_id, sequence)
     VALUES ($1, $2, $3, 0) ON CONFLICT (channel_id, user_id) DO NOTHING`,
    [s.environmentId, s.channelId, s.userId],
  );

  // THE QUOTA CHAPTER'S GUARD BAIT, one row per table it added to the array. Same
  // rule as `read_positions` above: a name in that array with no row behind it
  // installs a trigger that can never match, and reads as protection.
  //
  // `usage_active_users` reuses the sentinel's own user rather than minting one — the
  // row only has to exist — and `quota_notifications` reuses the organisation, which
  // it references and the sentinel already owns.
  await q(
    `INSERT INTO usage_periods (environment_id, period, messages_sent)
     VALUES ($1, $2, 0) ON CONFLICT (environment_id, period) DO NOTHING`,
    [s.environmentId, s.quotaPeriod],
  );
  await q(
    `INSERT INTO usage_active_users (environment_id, period, user_id)
     VALUES ($1, $2, $3) ON CONFLICT (environment_id, period, user_id) DO NOTHING`,
    [s.environmentId, s.quotaPeriod, s.userId],
  );
  // ALREADY DELIVERED, AND THAT IS THE FOURTH MEASUREMENT OF ONE LAW. The
  // disablement notifications and the webhook deliveries both had to concede the
  // same point: **bait may be claimable only where draining it is DATABASE work.**
  // A sweep or a publish qualifies; anything that does per-row I/O does not.
  //
  // `drainQuotaNotifications` claims on `delivered_at IS NULL` and then calls
  // `deliver(row)` — a mail send. So an undelivered bait row is claimed by every
  // quota relay in the lane.
  //
  // AND HERE THE LAW ARRIVES WITH TEETH RATHER THAN WITH LATENCY. The three earlier
  // instances cost seconds; this one is a hard failure, because the quota chapter
  // also put `quota_notifications` under the guard. The drain claims the sentinel's
  // row on a connection carrying no exemption, the trigger refuses the UPDATE, and
  // the transaction is poisoned — `25P02 in_failed_sql_transaction` on the next
  // statement, six tests red, and the message names neither the bait nor the guard.
  //
  // Delivered two hours ago, so the row is still a row a global count would see and
  // is outside every claim window.
  //
  // `DO UPDATE`, NOT `DO NOTHING`, AND THAT IS NOT TIDINESS. A sentinel's ids are
  // derived from its owner, so this row's id is the same on every run for ever — and
  // `DO NOTHING` would mean the state the row was FIRST planted with is the state it
  // keeps. A lane that ran this fixture once before the line above said
  // `delivered_at` holds an undelivered bait row that no later run can repair, and the
  // failure it causes is the one described above: refused, poisoned, six red. Here the
  // row's STATE is part of the fixture's contract and not merely its existence.
  await q(
    `INSERT INTO quota_notifications
       (id, environment_id, organisation_id, period, dimension, threshold,
        quota, usage_at_crossing, delivered_at)
     VALUES ($1, $2, $3, $4, 'messages', 50, 1, 1, now() - interval '2 hours')
     ON CONFLICT (id) DO UPDATE SET delivered_at = EXCLUDED.delivered_at`,
    [s.quotaNotificationId, s.environmentId, s.organisationId, s.quotaPeriod],
  );

  // DRAIN BAIT: unpublished events. `outbox` carries no environment_id — it is
  // platform bookkeeping — so the subject is what identifies these, and it is also
  // why the trigger cannot guard them (data-model.md). The count is `BAIT_ROWS` and
  // not one, because a single row cannot tell a batch that ignored its limit from
  // one that honoured it.
  //
  // AND IT IS AN `events.` SUBJECT WITH AN ENVELOPE ID, WHICH IT WAS NOT. Bait
  // imitates an unpublished event, and these rows sit in the one table the outbox
  // chapter's relay drains GLOBALLY, oldest first. A bait row is therefore reachable
  // by any test that drains for real, and the first version was unreachable in the
  // two ways that matter: `EVENTS` accepts `events.>` and nothing accepts
  // `<name>.bait`, so a real publish came back `NatsError: 503`; and `'{}'` carries
  // no `id`, so `publishPending` handed the broker `msgID: undefined` and every bait
  // row looked like the same event. Both were measured: 3,200 pending rows in 16
  // subjects, every unroutable row in this lane and no other.
  //
  // A FIXTURE THAT IMITATES A THING MUST BE USABLE EVERYWHERE THE THING IS. The
  // count, the table and the unpublished state — everything the bait is FOR — are
  // unchanged; what changed is the two fields that made it a landmine rather than
  // bait.
  await q(
    `INSERT INTO outbox (subject, payload)
     SELECT $1, jsonb_build_object('id', gen_random_uuid()::text, 'type', 'bait')
       FROM generate_series(1, $2)`,
    [`events.${s.name}.bait`, BAIT_ROWS],
  );
}
