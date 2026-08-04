import { sql } from "drizzle-orm";
import {
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
// absent, with named arrivals: message_edits (edit chapter), outbox
// (ADR-06's chapter), emoji/media tables (their parts), messages
// partitioning (SAD growth note -> retention chapter).

// DECISION (chapter 2.1): the SAD's environments table references
// applications(id) but never defines the table. This stub satisfies the
// foreign key; the real application lifecycle belongs to Part 3's tenancy
// chapters.
export const applications = pgTable("applications", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
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
