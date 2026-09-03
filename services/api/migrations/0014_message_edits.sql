-- Chapter 3.23 — what a message used to say.
--
-- PUBLISHED IN SAD §6.1 SINCE THE SAD WAS WRITTEN, and `schema.ts`'s absence
-- note named this chapter as its arrival. Reproduced column for column, which
-- is worth stating because the first draft of this chapter's data model gave
-- the table a surrogate `id UUID PRIMARY KEY` and said it was quoting the SAD.
-- It was not: three columns and a composite key.
--
-- HAND-WRITTEN, AND drizzle-kit's OUTPUT WAS DISCARDED. `drizzle-kit generate`
-- produced `0008_message_edits.sql` — a number already taken by
-- `0008_limit_policy.sql` — containing six whole CREATE TABLEs and fourteen
-- ALTERs replayed from migrations 0008 through 0013. Its snapshot sits at 0007
-- while this directory sits at 0013, because those six were hand-written too.
-- Applied to any database that has run them, the generated file fails on
-- `CREATE TABLE "quota_notifications"`. This is the review ADR-16 requires
-- doing its job: generation is a draft, the file is the artifact.
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
-- an edit is. Chapter 3.13 installed
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
