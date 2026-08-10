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
  },
  (t) => [
    unique("channels_environment_id_external_id_unique").on(
      t.environmentId,
      t.externalId,
    ), // DR-02
    check("channels_type_check", sql`${t.type} IN ('public','private')`),
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
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    // Hot-path index (SAD §6.3): the resume path's "which channels am I in".
    index("members_user_channel").on(t.userId, t.channelId),
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
