import { sql } from "drizzle-orm";
import {
  bigserial,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// The TS twin of SAD §6.1 (ADR-16). The schema now exists twice — once as
// the SAD's SQL truth, once here — and that drift risk is checked, not
// assumed away: drizzle-kit GENERATES the migration SQL from these
// definitions, and the generated SQL is reviewed against §6.1 before the
// runner applies it. The four tenant-bearing tables reproduce §6.1
// column-for-column, constraints and DR citations included. Deliberately
// absent, with named arrivals: message_edits (edit chapter), emoji/media
// tables (their parts), messages partitioning (SAD growth note -> retention
// chapter). The outbox arrived in 3.3 and is at the bottom of this file.

// The tenancy hierarchy (chapter 3.1). Everything from here to `members`
// below sits ABOVE the environment boundary: these rows say who owns a
// platform account, and they are the only tables in this file without an
// environment_id. Everything below the boundary carries one and is scoped by
// the repository (constitution I).
//
// DECISION (chapter 3.1): SAD §6.1 defines `environments` and everything under
// it, but never defines the containers above — the gap 2.1 papered over with a
// one-column `applications` stub. These three tables are derived from the SRS
// (FR-TEN-01/02/03/04/07), not quoted from the SAD, and that is why they carry
// this note.
export const organisations = pgTable("organisations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A person who signs in to Relay. NOT the `users` table below — see ADR-18.
// Identity is the provider account, never the email: emails change hands, and
// a provider may not release one at all (hence nullable).
export const humans = pgTable(
  "humans",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Signup idempotency, decided by the index rather than by a read-then-
    // write check that loses to a concurrent second click (2.3's lesson).
    unique("humans_provider_account_unique").on(
      t.provider,
      t.providerAccountId,
    ),
    check("humans_provider_check", sql`${t.provider} IN ('github','google')`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),
    humanId: uuid("human_id")
      .notNull()
      .references(() => humans.id),
    role: text("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organisationId, t.humanId] }),
    // A HUMAN'S ROLE IN AN ORGANISATION (FR-TEN-07), and NOT a channel role.
    //
    // `members.role` below is the other one: `('owner','moderator','member')`, a user's
    // role in a channel (FR-CHN-04). Different tables, different subjects, and ONE WORD
    // different — `admin` here, `moderator` there. A migration that reused this constraint
    // for channel members would accept `admin` on a channel member, refuse `moderator`,
    // and look correct in review. Chapter 3.15's research found that before writing it;
    // the comment sits on both sides because a warning on one side is a warning the next
    // person does not find.
    check(
      "memberships_role_check",
      sql`${t.role} IN ('owner','admin','member')`,
    ), // FR-TEN-07
  ],
);

// Replaces chapter 2.1's stub: an application now knows who owns it
// (FR-TEN-03). Deletion (FR-TEN-08) needs machinery this chapter does not
// build, so no cascade is declared — a cascade would imply a deletion story
// that does not exist yet.
export const applications = pgTable("applications", {
  id: uuid("id").primaryKey(),
  organisationId: uuid("organisation_id")
    .notNull()
    .references(() => organisations.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    kind: text("kind").notNull(),
    // envelope-encrypted (NFR-SEC-02)
    signingSecret: text("signing_secret").notNull(),
    retentionDays: integer("retention_days"),
    // DECLARED IN 2.1 AND STILL EMPTY. Named in SRS §6.1's Environment entity
    // and SAD §338, read by nothing in seventeen chapters. Chapter 3.8
    // deliberately did NOT put rate-limit policy here: the column is named for
    // quotas, quotas are a later chapter, and the distinction between a limit
    // that may be lost and a quota that is money is the thing 3.8 is about.
    // (Deliberately not a chapter NUMBER: 3.7 renumbered quotas once already,
    // and a comment in a file fenced byte-exact into a published page goes stale
    // silently. Chapter 3.7's rule — cite what a thing is, never where it will
    // be. A grep for forward references is the gate, so this comment must not
    // trip it either.) Putting
    // one in a field named for the other would collapse in the schema what the
    // prose spends a chapter drawing (research R31).
    quotaConfig: jsonb("quota_config").notNull().default({}),
    // Chapter 3.8: per-environment rate limits (FR-RTL-04, FR-RTL-04).
    //
    // NULLABLE, AND NULL IS NOT ZERO. Null means "no override, use the
    // documented default", resolved at read time. Zero means "refuse
    // everything", which must stay expressible — an environment can be switched
    // off deliberately — so the two states cannot share a representation.
    //
    // Three integers rather than a document, and a slot for an environment with
    // NONE FOR A ROUTE. That forecloses SRS Appendix C question 5 — whether the
    // dev-token endpoint should be limited more aggressively than the rest of
    // its environment — and the question stays open because of it (R30).
    restLimitPerMinute: integer("rest_limit_per_minute"),
    sendLimitPerMinute: integer("send_limit_per_minute"),
    connectLimitPerMinute: integer("connect_limit_per_minute"),
  },
  (t) => [
    check(
      "environments_kind_check",
      sql`${t.kind} IN ('development','production')`,
    ),
    // FR-TEN-04 says exactly two environments per application. With the CHECK
    // above, this unique index IS that rule: two legal kinds, one row each.
    // No trigger, no counting query, nothing to lose a race to.
    unique("environments_application_kind_unique").on(t.applicationId, t.kind),
    check(
      "environments_rest_limit_non_negative",
      sql`${t.restLimitPerMinute} IS NULL OR ${t.restLimitPerMinute} >= 0`,
    ),
    check(
      "environments_send_limit_non_negative",
      sql`${t.sendLimitPerMinute} IS NULL OR ${t.sendLimitPerMinute} >= 0`,
    ),
    check(
      "environments_connect_limit_non_negative",
      sql`${t.connectLimitPerMinute} IS NULL OR ${t.connectLimitPerMinute} >= 0`,
    ),
  ],
);

// DECISION (chapter 3.2): the SRS states the requirements this table serves
// (FR-AUT-01…05, NFR-SEC-02) but no source document defines a key table —
// SAD §6.1 does not have one. Its shape is a chapter derivation, recorded here
// the way 2.1 recorded `members` and 3.1 recorded the tenancy containers.
//
// It sits BELOW the environment boundary, so it carries an environment_id like
// every other table down here. The credential is two parts: `public_id` is an
// indexed, non-secret lookup handle, and only a salted hash of the secret half
// is ever stored. That split exists because authentication must resolve a
// tenant BEFORE one is known — the single query in this file that cannot be
// scoped, which is exactly why the lookup column is unique globally.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    publicId: text("public_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    salt: text("salt").notNull(),
    prefix: text("prefix").notNull(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Non-null means refused from that moment on. A timestamp rather than a
    // DELETE: a deleted row loses the record of what once had access
    // (FR-AUT-05).
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    // Globally unique, not per environment: the lookup happens before any
    // environment is known, so it must resolve to at most one row on its own.
    unique("api_keys_public_id_unique").on(t.publicId),
    // FR-AUT-03's two prefixes and nothing else. Several ACTIVE keys per
    // environment stay legal — that is what makes rotation possible without
    // downtime (FR-AUT-04), so nothing here constrains the count.
    check(
      "api_keys_prefix_check",
      sql`${t.prefix} IN ('rk_dev_','rk_live_')`,
    ),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    metadata: jsonb("metadata").notNull().default({}),
    bannedAt: timestamp("banned_at", { withTimezone: true }),
    // A DELETED USER KEEPS THIS ROW (chapter 3.15, FR-USR-05, research R7).
    //
    // This column is in no SRS clause. It arrived from designing the deletion path:
    // `messages.user_id`, `members.user_id` and `usage_active_users.user_id` all
    // reference `users.id`, and FR-USR-05 asks that a deleted user's messages be
    // preserved "as authored by a deleted user".
    //
    // `ON DELETE SET NULL` would satisfy the letter of that and break delivery.
    // `backfill.controller`'s `toFrame` drops senderless rows because `messageSchema`
    // requires `user`, so "authored by a deleted user" and "authored by nobody" are
    // different states and only the first is deliverable. `ON DELETE CASCADE` deletes
    // the messages the clause says to keep.
    //
    // So the row survives with its profile fields cleared, and this marker is what says
    // the row is deleted. `(environment_id, external_id)` stays unique, which is why
    // presenting the same external id again reuses this row and clears the marker
    // (FR-030) rather than creating a second identity.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("users_environment_id_external_id_unique").on(
      t.environmentId,
      t.externalId,
    ),
  ], // DR-02
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    externalId: text("external_id").notNull(),
    type: text("type").notNull(),
    name: text("name"),
    metadata: jsonb("metadata").notNull().default({}),
    lastSequence: bigint("last_sequence", { mode: "number" })
      .notNull()
      .default(0), // ADR-03
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // WHEN THIS CHANNEL LAST TOOK A MESSAGE (chapter 3.15, FR-014).
    //
    // A denormalised value, and the 145× is why. FR-CHN-08 wants a user's channels
    // ordered by most recent activity. `last_sequence` above cannot do it — it is a
    // per-channel counter, so two channels both at 50 say nothing about which was
    // active more recently. The alternative is `max(messages.created_at)` per channel,
    // measured at 2,000 channels and 1,000,000 messages:
    //
    //     aggregate over messages    159 ms   → Seq Scan, every message, every listing
    //     this column, indexed         1.1 ms
    //
    // The test lane answered the aggregate in 0.87 ms because its busiest environment
    // holds 579 messages, which is the number that would have settled the question the
    // wrong way (research R4).
    //
    // The write path already advances `last_sequence` in one statement; this moves with
    // it, in the same transaction. Nothing else writes it: a member joining, a rename or
    // an archive is not activity.
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("channels_environment_id_external_id_unique").on(
      t.environmentId,
      t.externalId,
    ), // DR-02
    check("channels_type_check", sql`${t.type} IN ('public','private')`),
    // The listing's ordering, scoped first (FR-013). Environment leads because every
    // listing is inside one and the planner can then walk the timestamp backward.
    index("channels_environment_last_activity").on(
      t.environmentId,
      t.lastActivityAt.desc(),
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    userId: uuid("user_id").references(() => users.id),
    // NULL => tombstone
    text: text("text"),
    metadata: jsonb("metadata").notNull().default({}),
    attachments: jsonb("attachments"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("messages_channel_id_sequence_unique").on(t.channelId, t.sequence), // DR-01
    // DR-03: idempotency enforced at the storage layer — the partial unique
    // index Prisma could not express is a first-class schema citizen here.
    uniqueIndex("messages_idem")
      .on(t.channelId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    // No dedicated (channel_id, sequence DESC) index: DR-01's unique
    // constraint above already supplies that ordering, and Postgres walks
    // it backward for newest-first pages. Chapter 2.4 measured it and
    // migration 0001 dropped the redundant twin (SAD §6.3, amended).
  ],
);

// DECISION (chapter 2.1): the docs/07 row and SAD §6.3's hot-path index
// both reference a members table that §6.1 never defines. This shape is
// anchored to that index; membership roles arrive with the channel
// semantics chapters.
export const members = pgTable(
  "members",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // A USER'S ROLE IN A CHANNEL (chapter 3.15, FR-CHN-04), default `member`.
    //
    // The default is what lets chapter 3.13's `addMember` keep working unchanged and
    // gives every existing row a value the CHECK accepts.
    role: text("role").notNull().default("member"),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    // ITS OWN CONSTRAINT, and NOT `memberships_role_check` above.
    //
    // `memberships.role` is `('owner','admin','member')` — a human's role in an
    // organisation, FR-TEN-07. This one is `('owner','moderator','member')` — FR-CHN-04's
    // three. One word apart, and reusing the other constraint here would accept `admin`
    // on a channel member, refuse `moderator`, and read as correct in review.
    check("members_role_check", sql`${t.role} IN ('owner','moderator','member')`),
    // Hot-path index (SAD §6.3): the resume path's "which channels am I in".
    index("members_user_channel").on(t.userId, t.channelId),
  ],
);

// HOW FAR EACH USER HAS READ IN EACH CHANNEL (chapter 3.15, FR-017, research R6).
//
// The only entity in this feature with no storage before it. Verified absent: no
// `last_read`, `read_at` or equivalent column anywhere in this file.
//
// THE UNREAD COUNT NEEDS NO COUNTER. It is
// `greatest(channels.last_sequence - sequence, 0)`, because the write path already
// maintains `last_sequence` and chapter 2.2 made it the sequencing authority. Three
// shapes measured on one page of 50 channels against 1,000,000 messages:
//
//     count rows past the position     9.8–13.4 ms
//     a cached counter on the position  1.2– 2.1 ms
//     last_sequence - this column       1.1– 4.5 ms
//
// The cached counter is no faster and adds a value that can go stale. The approximation
// this accepts, and FR-016 asks for it to be stated: a tombstoned message still occupies
// a sequence, so a deleted message counts as one unread. Counting rows instead is 10x the
// cost on the query a client runs to render its first screen.
//
// `environment_id` IS DENORMALISED HERE, DELIBERATELY. `channel_id` already determines
// it. The column exists because feature 030's guard watches tables that carry one, and a
// table without it is a table the guard cannot refuse a cross-environment delete on.
// `members` above is the counter-example and the reason this is worth saying: it has no
// `environment_id`, so `tenant-scope.itest.ts` classifies it as `hop` — reached through a
// foreign key — and no trigger protects it. A read position is per-user state that a
// tenant's own operations mutate, so it takes the stronger classification.
//
// NO `id` COLUMN, and the guard's refusal message is why that matters: it interpolates a
// key, and chapter 3.13 installed
// `coalesce(to_jsonb(OLD) ->> 'id', to_jsonb(OLD)::text)` for exactly this case.
export const readPositions = pgTable(
  "read_positions",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // The last sequence this user has read. Advances forwards only: a write naming a
    // lower value is accepted and changes nothing, so a client replaying an old
    // acknowledgement cannot move the count backwards. A value past
    // `channels.last_sequence` is refused (FR-018) — a position nothing can reach makes
    // every later count wrong.
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    // WRITTEN BY EVERY POSITION WRITE AND READ BY NOTHING, and that is a decision rather
    // than an oversight (chapter 3.16's `gaps.md` §5).
    //
    // Chapters 3.15 and 3.16 exist because five columns had no reader, so leaving a sixth
    // behind needs a sentence or it becomes the next feature's finding. The two options
    // were a reader — an operations view answering "when did this user last catch up" —
    // or a migration dropping it. Kept, on the expectation that the reader arrives.
    //
    // A column nobody chose to keep and a column somebody chose to keep look identical in
    // a schema. This comment is the only thing that tells them apart.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
  ],
);

// The outbox (chapter 3.3, ADR-06). For the first time in Part 3 this table is
// QUOTED rather than derived: SAD §6.1 defines it column-for-column, so nothing
// about its shape is a chapter invention.
//
// Three absences are deliberate and worth knowing about.
//
// No environment_id. Every other table below the tenant boundary carries one
// (FR-TEN-06); this one does not, because an outbox row is not tenant data — it
// is work the platform owes itself. The environment travels inside `subject`
// and `payload`, so a consumer can filter, but nothing reads this table on a
// tenant's behalf. Same family of exception as 3.2's unscoped key lookup, and
// recorded for the same reason.
//
// No status column. `published_at IS NULL` is the queue: a row is pending or it
// is done, and there is no third state to get stuck in.
//
// No attempts or last_error. Retry accounting belongs to webhook delivery
// (FR-WHK-03/06, chapter 3.5). This relay retries by not marking a row done.
export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    subject: text("subject").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    // DECISION (chapter 3.3): SAD §6.1 defines this table but no index for it.
    // The relay's only query is "the oldest rows with published_at IS NULL",
    // and without an index that degrades into a full scan over a table which is
    // 99.9% published rows. The predicate is PARTIAL on purpose: the index
    // covers only what the relay reads, so published rows cost nothing to keep
    // and pruning stays optional rather than urgent (ADR-06 calls pruning
    // trivial; it still needs a scheduler this platform does not have).
    index("outbox_unpublished")
      .on(t.createdAt)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);

// The consumer's deduplication ledger (chapter 3.4).
//
// DECISION (chapter 3.4): no source document defines a table for this. SAD risk
// R5 requires the BEHAVIOUR — "consumer template with dedup built in", so that
// "a future consumer forgets to dedupe → double webhooks / double metering"
// cannot happen — and leaves the shape open. This is therefore a chapter
// derivation, recorded here the way 2.1 recorded `members`, 3.2 recorded
// `api_keys` and 3.3 recorded the outbox's index.
//
// The PRIMARY KEY is the deduplication. Not a SELECT-then-INSERT: the insert
// itself is the check, so two instances fetching the same message concurrently
// cannot both decide they were first. 2.3 learned that on idempotency keys and
// 3.1 learned it again on signup.
//
// Keyed per CONSUMER, not globally. The dispatcher and the ingester must each
// receive every event; one ledger shared between them would let whichever
// arrived first silence the other.
//
// No environment_id, for the reason the outbox has none: this is the platform's
// own bookkeeping rather than tenant data (constitution I, 3.3's data model).
// No event body either — recording that an event was handled needs none of a
// tenant's message text (NFR-SEC-06).
export const consumedEvents = pgTable(
  "consumed_events",
  {
    consumer: text("consumer").notNull(),
    eventId: uuid("event_id").notNull(),
    handledAt: timestamp("handled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.eventId] })],
);

// ---------------------------------------------------------------------------
// Webhooks (chapter 3.5). Three tables, and all three carry `environment_id`.
//
// DECISION (chapter 3.5): 3.3's `outbox` and 3.4's `consumed_events` each
// omitted the tenant column and each recorded it as a deliberate exception. Two
// exceptions in consecutive chapters is a pattern, and a pattern without a
// stated rule is how a third chapter gets it wrong by resemblance. THE RULE: a
// table below the tenant boundary may omit `environment_id` only when it holds
// the platform's own bookkeeping AND no tenant-visible content. An endpoint is
// customer configuration; a dead letter holds a payload that was being sent to a
// customer. Both fail the test on both halves, so both are scoped and both join
// the cross-tenant gauntlet as targets.
//
// NAMED, NOT NUMBERED. This line used to say "chapter 3.7's cross-tenant
// gauntlet", and the gauntlet has moved three times since — carried by the
// comment none of them. A chapter number in a source comment is a reference that
// ages every time the plan changes, and this file is fenced byte-exact into a
// published chapter, so correcting it costs a fence amendment.
//
// The sentence you are reading replaced one that stated the ordinals and went
// stale in the very next chapter, which is the rule proving itself on its own
// explanation. It now names no numbers at all. The subject does not move; the
// ordinal does.
// ---------------------------------------------------------------------------

// DECISION (chapter 3.5): no source document defines this table. FR-WHK-01 and
// FR-WHK-08 require the behaviour — up to five endpoints per environment, each
// with an independently rotatable signing secret — and leave the shape open.
//
// The secret is stored ENCRYPTED, not hashed, and the difference is the point.
// An API key (3.2) is VERIFIED: a caller presents it, we hash what arrived and
// compare. A signing secret is USED: we must compute an HMAC with it, which
// needs the secret itself. A hash cannot be used, only compared. NFR-SEC-02
// permits "salted hashes OR envelope encryption" and this is the branch that
// applies — two credentials, one requirement, two mechanisms, because the verbs
// differ (research R3).
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    url: text("url").notNull(),
    // The subscription set. An endpoint receives only these (FR-WHK-02).
    eventTypes: jsonb("event_types").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    // Non-null only during a rotation window: both secrets sign, so a recipient
    // accepting either is correct throughout (contracts/webhooks.md §Rotation).
    secretPreviousCiphertext: text("secret_previous_ciphertext"),
    secretRotatedAt: timestamp("secret_rotated_at", { withTimezone: true }),
    // An owner can pause an endpoint. Chapter 3.6 is the follow-on chapter 3.5
    // named here, and the prediction held: automatic disablement added a rule and
    // four columns, and did not have to change this one.
    enabled: boolean("enabled").notNull().default(true),
    // THE FAILURE RUN (chapter 3.6, FR-006). The current unbroken sequence of
    // failures, and nothing more — history is the attempt event stream, not this.
    //
    // Two columns rather than a table, because a run is one row per endpoint BY
    // DEFINITION: it is the *current* run, and there is only ever one. A table
    // would need a "which row is current" rule, and that rule is the bug
    // (research R2). Both null when the endpoint is healthy, and any delivered
    // outcome sets them back to null.
    failureRunStartedAt: timestamp("failure_run_started_at", {
      withTimezone: true,
    }),
    failureRunAttempts: integer("failure_run_attempts"),
    // WHO SWITCHED IT OFF, which `enabled` alone cannot say. Auto-disable sets
    // `enabled = false` AND stamps these; a customer pausing their own endpoint
    // sets `enabled = false` and leaves them null. That asymmetry IS FR-009: a
    // customer can tell a platform disablement from their own by whether the
    // platform left its fingerprints.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // DELETION IS SOFT, and this column is why. Chapter 3.2 made the same
    // choice for `api_keys.revokedAt` and gave the reason: "a deleted row loses
    // the record of what once had access". Here the stakes are higher — a hard
    // delete would have to cascade, and cascading would erase the customer's
    // dead letters, which FR-WHK-04 says to retain for seven days. So a deleted
    // endpoint stops receiving deliveries and stops appearing in listings, and
    // the record of what it was survives its deletion.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("webhook_endpoints_environment_idx").on(t.environmentId),
    // The SWEEP's only query (chapter 3.6, research R1): enabled endpoints with
    // an open failure run, so the one that has outrun the hour can be found
    // without reading every endpoint in the platform. Partial, for the reason
    // 3.3's outbox index and 3.5's delivery index are partial — a healthy
    // endpoint has a null run and costs nothing to keep out of it.
    index("webhook_endpoints_failure_run_idx")
      .on(t.failureRunStartedAt)
      .where(sql`${t.enabled} AND ${t.failureRunStartedAt} IS NOT NULL`),
    // The two halves of a run travel together, and the database says so rather
    // than four call sites remembering to. A run with a start and no count, or a
    // count and no start, is not a state this platform has a meaning for — and
    // `shouldDisable` would read the missing half as zero, which is the shape of
    // a bug that disables nothing and looks like a policy decision.
    check(
      "webhook_endpoints_failure_run_check",
      sql`(${t.failureRunStartedAt} IS NULL) = (${t.failureRunAttempts} IS NULL)`,
    ),
    // Same argument for the disable stamp. FR-009 rests on `disabled_at` being
    // the platform's fingerprint, so a reason without a timestamp would make the
    // one distinction a customer needs unreadable.
    check(
      "webhook_endpoints_disabled_check",
      sql`(${t.disabledAt} IS NULL) = (${t.disabledReason} IS NULL)`,
    ),
  ],
);

// The retry schedule — and it is chapter 3.3's outbox with one more column.
//
// DECISION (chapter 3.5, research R1, MEASURED): the obvious implementation is
// to let the broker hold the delay between attempts. It was measured against a
// real broker and disqualified: a delayed redelivery survives a restart to
// within 3 ms, but a message waiting out its delay HOLDS AN ACKNOWLEDGEMENT
// SLOT the whole time. With `max_ack_pending=3`, three messages nak'd for five
// minutes made two available messages unfetchable. Scaled up, a handful of dead
// customer endpoints starve deliveries to healthy ones — exactly what FR-WHK-05
// forbids, and invisible until an incident.
//
// So a delivery that is not due yet is a ROW, not a message the broker holds.
// The whole schedule is `next_attempt_at`; the api's relay publishes a delivery
// only once it is already due. Nothing waits in the broker.
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id),
    // Chapter 3.3's envelope id — the customer's deduplication key, stable
    // across every attempt and across a dead-letter replay (spec FR-018).
    eventId: uuid("event_id").notNull(),
    payload: jsonb("payload").notNull(),
    // 1..7 — the INDEX INTO THE TIER TABLE, not a free-running counter.
    // `attempt = 5` means "the 5-minute tier", which is what makes recomputing
    // `next_attempt_at` total rather than incremental. Seven, not six: FR-WHK-03
    // names six retry delays and the initial delivery makes seven requests —
    // see webhooks/schedule.ts's DECISION for why the delay list won.
    attempt: integer("attempt").notNull().default(1),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set when the relay publishes it; cleared when the next attempt is
    // scheduled. The relay's claim, in the shape `outbox.published_at` has.
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    state: text("state").notNull().default("pending"),
    // WHAT THE ENDPOINT ACTUALLY SAID on the most recent attempt (chapter 3.6).
    //
    // Chapter 3.5 recorded an attempt by MOVING the delivery — state, attempt,
    // next_attempt_at — and threw the answer away, which was enough while the
    // only reader was the retry schedule. Two things here need it back, and
    // neither can get it from the attempt event: that publish is at-most-once by
    // design (research R5).
    //
    //   * the test event reports what the endpoint answered to a caller who is
    //     WAITING, and the attempt happens in the dispatcher's process (FR-016);
    //   * the sweep writes a disablement's last observed error, and the sweep
    //     fires precisely when no outcome is arriving — that is the whole of
    //     research R1. Without this it could only write null, and "disabled,
    //     cause unknown" is the notification a support engineer receives.
    //
    // `lastLatencyMs` is the third thing in this chapter to pick `latency_ms` up
    // off the floor: it has crossed the internal seam on every attempt since 3.5
    // and been discarded (research R6).
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    lastLatencyMs: integer("last_latency_ms"),
    // A TEST EVENT's delivery (chapter 3.6, FR-013). Three decisions branch on
    // it — no retry schedule, no failure-run update, and delivery even to a
    // disabled endpoint — which is why it is a column and not a `payload->>'type'`
    // comparison against a customer-visible document. It also keeps the marker
    // for the RECIPIENT (the envelope's `type` and `test`) separate from the
    // marker for the PLATFORM, two audiences that happen to agree today.
    synthetic: boolean("synthetic").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One event produces at most one delivery per endpoint. This is what makes
    // expansion idempotent at the database rather than by care (research R2).
    unique("webhook_deliveries_event_endpoint_unique").on(t.eventId, t.endpointId),
    check(
      "webhook_deliveries_state_check",
      sql`${t.state} IN ('pending','delivered','dead')`,
    ),
    // The relay's only query: pending rows that are due, oldest first. Partial,
    // for the reason 3.3's outbox index is partial — it covers only what the
    // relay reads, so delivered rows cost nothing to keep.
    index("webhook_deliveries_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.state} = 'pending'`),
  ],
);

// DECISION (chapter 3.5): FR-WHK-04 requires exhausted events to be retained
// for seven days, inspectable and replayable, and leaves the shape open.
//
// This is the first store in the platform whose PURPOSE is retaining data that
// failed to leave. Retention is therefore a liability rather than a feature: a
// dead-letter table with no expiry is a place tenant data accumulates until an
// audit finds it. Pruning is named and deferred; the chapter says what happens
// on day eight and means it.
export const webhookDeadLetters = pgTable(
  "webhook_dead_letters",
  {
    id: uuid("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id),
    // Reused on replay, so a customer who deduplicates correctly is unharmed by
    // an operator replaying something they already received.
    eventId: uuid("event_id").notNull(),
    payload: jsonb("payload").notNull(),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull(),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("webhook_dead_letters_environment_idx").on(t.environmentId)],
);

// DECISION (chapter 3.6, FR-011, research R7): one row per automatic
// disablement — an OUTBOUND OBLIGATION the platform has not yet met.
//
// `deliveredAt` is the honest column, and it exists in this chapter solely in
// order to be null. FR-WHK-07 asks for the endpoint to be disabled "and the
// organisation notified by email", and this platform has no email transport of
// any kind. A later chapter needs the same transport for quotas, so building one
// here would mean building it for its second consumer first. (Named rather than
// numbered: see the note on the dead-letter table above.)
//
// A schema that recorded only the disablement would let a future reader believe
// the requirement was finished. This one says, in a column, which half is
// missing.
//
// Why a table rather than more columns on the endpoint: the endpoint gains
// `disabledAt` and `disabledReason` regardless, because FR-009 needs a customer
// to tell a platform disablement from their own. The notification is a different
// kind of thing — a record with a lifecycle, which is what `deliveredAt` makes
// visible.
export const webhookDisableNotifications = pgTable(
  "webhook_disable_notifications",
  {
    id: uuid("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    // DENORMALISED on purpose. The joins are available —
    // environments.application_id → applications.organisation_id — so storing it
    // looks redundant. It is stored because this row records an obligation AS IT
    // STOOD when the endpoint was disabled, and an application moving between
    // organisations later must not silently retarget a notification that was
    // already owed to somebody else.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id),
    disabledAt: timestamp("disabled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // The window that triggered it, copied rather than referenced: the endpoint's
    // own run columns are cleared the moment a customer re-enables it, and a
    // notification that lost its evidence on re-enablement would be unanswerable
    // by the time anybody read it.
    runStartedAt: timestamp("run_started_at", { withTimezone: true }).notNull(),
    runAttempts: integer("run_attempts").notNull(),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    // NULL THROUGHOUT THIS CHAPTER. Set by whatever chapter builds a transport.
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    // Nothing beyond the primary key and the tenant. Volume is one row per
    // endpoint per outage, so an index for any other access pattern would be
    // guessing at a query nobody has written.
    index("webhook_disable_notifications_environment_idx").on(t.environmentId),
  ],
);

// ---------------------------------------------------------------------------
// Chapter 3.10 — monthly usage quotas (FR-RTL-05 to FR-RTL-08).
// ---------------------------------------------------------------------------
//
// The POLICY is not here, because it was already here. `environments.quotaConfig`
// has been declared since chapter 2.1 and read by nothing for eighteen chapters;
// 3.8 was offered it for rate-limit policy and refused it in prose, on the
// grounds that the column is named for quotas and quotas are a later chapter.
// This is that chapter. `quotas/config.ts` is the only thing that parses it.
//
// `date` IS THIS PROJECT'S FIRST, against 28 `timestamp` columns, and it is half
// a primary key here and a third of one below. Drizzle's `date` in its default
// mode reads and writes `YYYY-MM-DD` strings, which is what `quotas/period.ts`
// produces — a `Date` on one side of that comparison and a string on the other is
// a row that cannot be found rather than an error (research R7a).

export const usagePeriods = pgTable(
  "usage_periods",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    period: date("period").notNull(),
    // `{ mode: "number" }` like the two bigints this project already has
    // (`channels.lastSequence`, `messages.sequence`). Drizzle requires a mode,
    // and a cumulative count that overflowed would be a wrong bill rather than a
    // wrapped counter.
    messagesSent: bigint("messages_sent", { mode: "number" })
      .notNull()
      .default(0),
    // Chapter 3.11's third figure, same type for the same reason. Ten thousand
    // sockets held continuously accrue 5.26 billion connection-minutes a year
    // and `integer` stops at 2,147,483,647 — about five months in.
    connectionMinutes: bigint("connection_minutes", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.period] }),
    check(
      "usage_periods_messages_sent_non_negative",
      sql`${t.messagesSent} >= 0`,
    ),
    check(
      "usage_periods_connection_minutes_non_negative",
      sql`${t.connectionMinutes} >= 0`,
    ),
  ],
);

// One row per connection per period, and the whole of chapter 3.11's
// idempotency (research R4).
//
// A report says what a connection has consumed IN TOTAL, not since last time.
// The api credits `max(0, reported - credited)` and stores the new total, so a
// replayed report credits nothing and a lost one is repaired by the next. That
// is what lets the gateway keep no outbox at all.
//
// NOT ONE ROW PER MINUTE, which is the obvious dedup key and 43.2 million rows a
// month at a thousand concurrent sockets. Bounded by connections instead — the
// same trade `usageActiveUsers` above makes for users against traffic.
//
// `period` is in the key because a connection open across a month boundary owes
// minutes to two periods; `connectionId` alone would already be unique.
export const usageConnections = pgTable(
  "usage_connections",
  {
    connectionId: uuid("connection_id").notNull(),
    period: date("period").notNull(),
    // Written by the first report and never updated. A later report naming a
    // different environment for this connection is refused, not reconciled: a
    // connection does not move between tenants (constitution I).
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    minutes: bigint("minutes", { mode: "number" }).notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.period] }),
    check("usage_connections_minutes_non_negative", sql`${t.minutes} >= 0`),
  ],
);

// One row per user per period. A message count is `+1`; a distinct-user count is
// not, because incrementing it needs to know whether this user already sent this
// period — which is a read. The row IS the answer, written `ON CONFLICT DO
// NOTHING`, and bounded by the tenant's users rather than by their traffic.
export const usageActiveUsers = pgTable(
  "usage_active_users",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    period: date("period").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.period, t.userId] })],
);

// THE OUTBOX, A FOURTH TIME — after 3.3's events, 3.5's deliveries and 3.9's
// disablement emails. Four concrete tables that look alike is a pattern; one
// abstract table serving four purposes is a framework.
//
// `webhookDisableNotifications` cannot be reused: its `endpointId` is NOT NULL
// and a quota crossing has no endpoint.
export const quotaNotifications = pgTable(
  "quota_notifications",
  {
    id: uuid("id").primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id),
    period: date("period").notNull(),
    dimension: text("dimension").notNull(),
    threshold: integer("threshold").notNull(),
    // What the figures were WHEN IT HAPPENED. The cap can change between the
    // crossing and the delivery, and an email saying "80% of 10,000" should mean
    // the 10,000 that was true at the time.
    quota: bigint("quota", { mode: "number" }).notNull(),
    usageAtCrossing: bigint("usage_at_crossing", { mode: "number" }).notNull(),
    crossedAt: timestamp("crossed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [
    check(
      "quota_notifications_dimension_check",
      sql`${t.dimension} IN ('messages', 'active_users')`,
    ),
    check(
      "quota_notifications_threshold_check",
      sql`${t.threshold} IN (50, 80, 100)`,
    ),
    // THIS CONSTRAINT IS FR-RTL-07. At most one email per threshold per quota per
    // period, enforced by the schema rather than promised by the code that writes
    // it, so a concurrent double-crossing resolves to one row and not two emails.
    unique("quota_notifications_once_per_threshold").on(
      t.environmentId,
      t.period,
      t.dimension,
      t.threshold,
    ),
  ],
);
