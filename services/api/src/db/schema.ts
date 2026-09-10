import { sql } from "drizzle-orm";
import {
  bigserial,
  bigint,
  check,
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
// absent, with named arrivals: emoji/media tables (their parts), messages
// partitioning (SAD growth note -> retention chapter). The outbox arrives with the
// chapter of that name and is at the bottom of this file. `message_edits` ARRIVES WITH
// THE REVISIONS CHAPTER and is below `messages` — the list above said "edit chapter"
// and this is it.

// The tenancy hierarchy. Everything from here to `members`
// below sits ABOVE the environment boundary: these rows say who owns a
// platform account, and they are the only tables in this file without an
// environment_id. Everything below the boundary carries one and is scoped by
// the repository (constitution I).
//
// DECISION: SAD §6.1 defines `environments` and everything under
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
    // and look correct in review. The channel-control chapter's research found that before writing it;
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
    quotaConfig: jsonb("quota_config").notNull().default({}),
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
  ],
);

// DECISION: the SRS states the requirements this table serves
// (FR-AUT-01…05, NFR-SEC-02) but no source document defines a key table —
// SAD §6.1 does not have one. Its shape is a chapter derivation, recorded here
// the way 2.1 recorded `members` and the tenancy chapter recorded its containers.
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
    // A DELETED USER KEEPS THIS ROW (FR-USR-05, research R7).
    //
    // This column is in no SRS clause. It arrived from designing the deletion path:
    // `messages.user_id`, `members.user_id` and `read_positions.user_id` all
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
    // WHAT KIND OF THING THIS USER IS (FR-USR-07).
    //
    // A stored property on the row a customer already knows about, not a second table.
    // Every reader built since the channel-control chapter reads `users`; a `bots` table would have
    // needed each of them taught a second place to look, and a message's `user_id`
    // would have had to reference one of two tables.
    //
    // `NOT NULL DEFAULT 'person'` is metadata-only on Postgres 11+, so the existing
    // rows are not rewritten — the user-surface chapter measured that for `last_activity_at`.
    // The default belongs HERE, at creation, and NOT in the request schema: a schema
    // default would make "absent" indistinguishable from "person" before anything can
    // compare it to the stored row, and telling those two apart is what makes a
    // promotion reportable (FR-002b).
    kind: text("kind").notNull().default("person"),
    // WHAT THE SOFTWARE IS, AND WHY IT POSTS (FR-USR-07).
    //
    // NOT PROFILE DATA, and `deleteUser` must not clear it (FR-004a). FR-027 clears
    // `display_name`, `avatar_url` and `metadata` on deletion; clearing this one would
    // violate `users_bot_description_check` below and make a bot the one kind of user
    // that cannot be deleted.
    description: text("description"),
  },
  (t) => [
    unique("users_environment_id_external_id_unique").on(
      t.environmentId,
      t.externalId,
    ), // DR-02
    // THE CONSTRAINED TEXT COLUMNS IN THIS SCHEMA NAME EACH OTHER (THE CHANNEL-CONTROL CHAPTER'S
    // practice, applied here): `channels_type_check` on `channels.type`,
    // `members_role_check` on `members.role`, `memberships_role_check` on an
    // organisation membership's role, and this pair. One word apart is how `admin`
    // nearly reached a channel member, so each of these says where its siblings are.
    //
    // AND `environments.kind` IS THE ONE THAT IS NOT CONSTRAINED. It has held
    // `development` or `production` since chapter 2.1 (FR-TEN-04) with no CHECK, so
    // this schema now has two columns called `kind` and only one of them cannot hold
    // a typo. Named here rather than fixed: adding a constraint to a column
    // seventeen chapters old is not this chapter's change, and leaving the asymmetry
    // unmentioned is how the next reader assumes both are guarded.
    check("users_kind_check", sql`${t.kind} IN ('person','bot')`),
    // THE SECOND CHECK IS THE REQUIREMENT, not a nicety. It makes a bot without a
    // description **unrepresentable** rather than merely refused: zod refuses one at
    // the boundary (FR-002, FR-004b) and this refuses one from any writer, including
    // a migration, a backfill, or a psql session. A description is what turns an
    // opaque sender into an answerable one, so a bot without one is not a bot.
    check(
      "users_bot_description_check",
      sql`${t.kind} <> 'bot' OR ${t.description} IS NOT NULL`,
    ),
  ],
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
    /** How many revisions this channel's messages have received (feature 044, FR-001).
     *
     * A REVISION IS AN EDIT OR A DELETION, and each raises this by exactly one. A SEND
     * DOES NOT (FR-011): a new message is delivered by the ordinary replay, and counting
     * sends here would make every active channel report a repair after every absence.
     *
     * WHAT IT ANSWERS. Resume is ordered by `lastSequence` above, and a revision carries
     * the sequence of the message it changes rather than a new one — so a message revised
     * below a client's cursor reaches it on no frame and consumes no sequence, leaving no
     * gap to notice. This is the number a reconnecting client compares against to learn
     * that it holds something stale.
     *
     * `{ mode: "number" }` and `bigint`, matching `lastSequence` for the same reason. */
    revisionSequence: bigint("revision_sequence", { mode: "number" })
      .notNull()
      .default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // WHEN THIS CHANNEL LAST TOOK A MESSAGE (FR-014).
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

// WHAT A MESSAGE USED TO SAY (FR-MSG-07). Published in SAD §6.1
// since the SAD was written and built here — the absence note above named this
// chapter as its arrival.
//
// REPRODUCED FROM §6.1 COLUMN FOR COLUMN, which is worth saying because the
// first draft of this chapter's data model gave the table a surrogate
// `id UUID PRIMARY KEY` and stated that it was quoting the SAD. It was not.
// Three columns and a composite key:
//
//     PRIMARY KEY (message_id, edited_at)
//
// The key is a constraint with a cost the SAD does not spell out: two edits to
// one message at the same timestamp collide rather than both being kept.
// Postgres holds microseconds, so that needs two edits inside one microsecond
// on one message. A surrogate id would take both rows and leave a history with
// two entries claiming the same instant, which is a silent wrong answer where
// this is a loud refusal. The published constraint stands (Constitution VII).
//
// APPEND ONLY (FR-004). Nothing updates or deletes a row here. A
// second edit appends a second row; the current text lives on `messages`.
//
// NO `environment_id`, exactly like `messages` above. The tenant is reached
// through `message_id -> messages -> channels`, which is how every read below
// the boundary already scopes (constitution I).
export const messageEdits = pgTable(
  "message_edits",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
    editedAt: timestamp("edited_at", { withTimezone: true }).notNull(),
    // FR-MSG-07: what the message said before this edit. NOT NULL, and that
    // has a consequence the chapter meets rather than works around: a deletion
    // writes no row here, because a tombstone has no text to preserve. FR-010
    // refuses an edit on a tombstone instead of defining what its history
    // would say.
    priorText: text("prior_text").notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.editedAt] })],
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
    // A USER'S ROLE IN A CHANNEL (FR-CHN-04), default `member`.
    //
    // The default is what lets the channel-endpoints chapter's `addMember` keep working unchanged and
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

// HOW FAR EACH USER HAS READ IN EACH CHANNEL (FR-017, research R6).
//
// The only entity in this chapter with no storage before it. Verified absent: no
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
// it. The column exists because the lane's guard watches tables that carry one, and a
// table without it is a table the guard cannot refuse a cross-environment delete on.
// `members` above is the counter-example and the reason this is worth saying: it has no
// `environment_id`, so `tenant-scope.itest.ts` classifies it as `hop` — reached through a
// foreign key — and no trigger protects it. A read position is per-user state that a
// tenant's own operations mutate, so it takes the stronger classification.
//
// NO `id` COLUMN, and the guard's refusal message is why that matters: it interpolates a
// key, and the endpoints chapter installed
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
    // than an oversight (the user-surface chapter's `gaps.md` §5).
    //
    // The channel-control and user-surface chapters exist because five columns had no
    // reader, so leaving a sixth
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

// The outbox (ADR-06). For the first time in Part 3 this table is
// QUOTED rather than derived: SAD §6.1 defines it column-for-column, so nothing
// about its shape is a chapter invention.
//
// Three absences are deliberate and worth knowing about.
//
// No environment_id. Every other table below the tenant boundary carries one
// (FR-TEN-06); this one does not, because an outbox row is not tenant data — it
// is work the platform owes itself. The environment travels inside `subject`
// and `payload`, so a consumer can filter, but nothing reads this table on a
// tenant's behalf. Same family of exception as the credentials chapter's unscoped key lookup, and
// recorded for the same reason.
//
// No status column. `published_at IS NULL` is the queue: a row is pending or it
// is done, and there is no third state to get stuck in.
//
// No attempts or last_error. Retry accounting belongs to webhook delivery
// (FR-WHK-03/06). This relay retries by not marking a row done.
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
    // DECISION: SAD §6.1 defines this table but no index for it.
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

// The consumer's deduplication ledger.
//
// DECISION: no source document defines a table for this. SAD risk
// R5 requires the BEHAVIOUR — "consumer template with dedup built in", so that
// "a future consumer forgets to dedupe → double webhooks / double metering"
// cannot happen — and leaves the shape open. This is therefore a chapter
// derivation, recorded here the way 2.1 recorded `members`, the credentials chapter recorded
// `api_keys` and the outbox chapter recorded the outbox's index.
//
// The PRIMARY KEY is the deduplication. Not a SELECT-then-INSERT: the insert
// itself is the check, so two instances fetching the same message concurrently
// cannot both decide they were first. 2.3 learned that on idempotency keys and
// the tenancy chapter learned it again on signup.
//
// Keyed per CONSUMER, not globally. The dispatcher and the ingester must each
// receive every event; one ledger shared between them would let whichever
// arrived first silence the other.
//
// No environment_id, for the reason the outbox has none: this is the platform's
// own bookkeeping rather than tenant data (constitution I, the outbox chapter's data model).
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
