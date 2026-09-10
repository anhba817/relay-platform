-- What a message used to say.
--
-- PUBLISHED IN SAD §6.1 SINCE THE SAD WAS WRITTEN, and `schema.ts`'s absence
-- note named this chapter as its arrival. Reproduced column for column, which
-- is worth stating because the first draft of this chapter's data model gave
-- the table a surrogate `id UUID PRIMARY KEY` and said it was quoting the SAD.
-- It was not: three columns and a composite key.
--
-- HAND-WRITTEN, AND drizzle-kit's OUTPUT WAS DISCARDED. `drizzle-kit generate`
-- produced `0006_wise_lyja.sql` — a number already taken by
-- `0006_member_roles.sql` — containing two whole CREATE TABLEs, twelve ALTERs
-- and an index replayed from migrations 0006 through 0008. Its snapshot sits at
-- 0005 while this directory sits at 0008, because those three were hand-written
-- too. Applied to any database that has run them, the generated file fails on
-- `CREATE TABLE "read_positions"`. This is the review ADR-16 requires doing its
-- job: generation is a draft, the file is the artifact.
--
-- WHAT THE COMPOSITE KEY COSTS. Two edits to one message at the same timestamp
-- collide rather than both being stored. Postgres holds microseconds, so that
-- needs two edits inside one microsecond on one message. A surrogate id would
-- accept both and leave a history with two rows claiming the same instant,
-- which is a silent wrong answer where this is a loud refusal. The published
-- constraint stands (Constitution VII).
--
-- APPEND ONLY (FR-004). Nothing updates or deletes a row here; a second edit
-- appends a second row and the current text stays on `messages`.
--
-- NO environment_id, exactly like `messages`. The tenant is reached through
-- message_id -> messages -> channels. `members` is the precedent feature 030's
-- guard classifies as `hop` for the same reason, and this table is the same
-- shape of thing: rows about a message, not rows about a tenant.
--
-- NO id COLUMN. The primary key is (message_id, edited_at) because that is what
-- an edit is. the channel-endpoints chapter installed
-- `coalesce(to_jsonb(OLD) ->> 'id', to_jsonb(OLD)::text)` in the guard's
-- refusal message for exactly the tables that have no `id` to interpolate.
CREATE TABLE message_edits (
    message_id  UUID NOT NULL REFERENCES messages(id),
    edited_at   TIMESTAMPTZ NOT NULL,
    -- FR-MSG-07: what the message said before this edit. NOT NULL, and the
    -- consequence is met rather than worked around — a deletion writes no row
    -- here, because a tombstone has no text to preserve, so FR-010 refuses an
    -- edit on a tombstone instead of defining what its history would say.
    prior_text  TEXT NOT NULL,
    CONSTRAINT message_edits_message_id_edited_at_pk PRIMARY KEY (message_id, edited_at)
);

--> statement-breakpoint

-- ONE MIGRATION, ONE SUBJECT: REVISIONS. `message_edits` above preserves what a message
-- used to say; the column below counts how many times it has changed. Both are this
-- chapter's subject, and splitting them across two migrations would number one of them
-- after work that has nothing to do with either.
-- HOW MANY REVISIONS A CHANNEL HAS SEEN, and why it lives in this migration.
--
-- WHAT IT IS FOR. Resume is ordered by the channel sequence, and an edit or a
-- deletion carries the sequence of the message it CHANGES rather than a new one.
-- A message revised below a client's cursor is therefore in neither the replay
-- nor the live stream, and consumes no sequence, so no gap appears for a client
-- to notice. SRS FR-016a says the stale copy is repairable by re-reading
-- history; nothing told a client when to. This column is what a reconnecting
-- client compares against.
--
-- MEASURED BEFORE IT WAS BUILT. A client holding message seq 1, reconnecting on
-- cursor 2 after that message was edited, received exactly one frame — the ack —
-- and zero sequences. The edit was never delivered. The same probe confirmed the
-- other half: a message edited ABOVE the cursor comes back on the replay with its
-- new text, because the backfill reads current state.
--
-- EXECUTABLE WITHOUT DOWNTIME, which the constitution requires of every
-- migration. `ADD COLUMN ... NOT NULL DEFAULT` is metadata-only from PostgreSQL
-- 11: the default is stored in the catalogue and existing rows are not rewritten.
-- On 10 and below this statement rewrites the whole table and takes an ACCESS
-- EXCLUSIVE lock for the duration. This platform targets 15 (SAD §6.1), and the
-- version the property depends on belongs in the file rather than in somebody's
-- memory.
--
-- BIGINT, MATCHING channels.last_sequence. A channel revised once a second for a
-- century reaches 3.2 billion, which overflows `integer` and does not trouble
-- `bigint`. The sequence column made the same choice for the same reason.
--
-- DEFAULT 0 AND NOT A COUNT RECONSTRUCTED FROM HISTORY. `message_edits` and
-- `messages.deleted_at` between them could produce a true count for every
-- existing channel, and it would be correct and useless: it would exceed every
-- client's stored count on the first reconnect after this ships, and tell every
-- client to repair every channel once. Starting at zero means a revision applied
-- before this migration is never repaired for a client already holding the stale
-- copy — which is the current behaviour continuing, not a new defect.
--
-- NO INDEX. The column is read by primary key on a row the membership query
-- already joins. An index would serve no query that exists.

ALTER TABLE channels
  ADD COLUMN revision_sequence BIGINT NOT NULL DEFAULT 0;
