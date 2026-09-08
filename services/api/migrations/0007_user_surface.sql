-- Ordering a user's channels, knowing what they have not read, and a deleted user
-- who is still an author.
--
-- THREE COLUMNS AND A TABLE, IN ONE FILE, BECAUSE THEY BELONG TO ONE CHAPTER. The
-- design that produced them split them across two migrations by SUBJECT — an
-- activity-and-read-positions file and a roles-and-user-deletion file — and neither
-- file belonged to one chapter. The previous chapter took `members.role` as `0006`
-- and left the rest here, which is the whole of it: a migration's number should
-- follow the chapter that introduces it.
--
-- The first two answer a question `last_sequence` looks like it should answer and
-- cannot.
--
-- FR-CHN-08 wants a user's channels ordered by most recent activity.
-- `channels.last_sequence` is a per-channel monotonic counter, so two channels both
-- sitting at 50 say nothing about which took a message more recently. It orders
-- messages inside one channel and cannot order channels against each other at all.
--
-- THE ALTERNATIVE WAS MEASURED AND IT IS 145x WORSE. Ordering by
-- `max(messages.created_at)` per channel, at 2,000 channels and 1,000,000 messages
-- with one member in every channel:
--
--     aggregate over messages   159.737 ms  158.103 ms  158.842 ms
--                               -> Seq Scan on messages, 1,000,000 rows,
--                                  on every listing
--     indexed column              1.102 ms    1.496 ms    2.210 ms
--
-- AND THE TEST LANE SAYS THE OPPOSITE. Its busiest environment holds 579 messages,
-- and the same aggregate answers in 0.870 ms there. Reporting that number would
-- have settled the question in favour of adding no column. The cost grows with
-- message volume, which is the one number a chat platform guarantees will grow
-- (research R4).
--
-- `now()` AS THE DEFAULT, AND A BACKFILL AFTER THIS FILE. Adding a column with a
-- constant default is fast — Postgres 11 and later store it in the catalogue rather
-- than rewriting the table. Setting every existing channel to its real last activity
-- is `max(messages.created_at)` per channel, which is the scan above, so it does NOT
-- belong in a migration: the workflow requires migrations to be executable without
-- downtime. It runs afterwards, in batches, as its own step.
ALTER TABLE channels
    ADD COLUMN last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now();
--> statement-breakpoint

-- The listing's ordering (FR-013), environment first because every listing is inside
-- one and the planner then walks the timestamp backward from there.
CREATE INDEX channels_environment_last_activity
    ON channels USING btree (environment_id, last_activity_at DESC NULLS LAST);
--> statement-breakpoint

-- FR-CHN-09's unread count needs to know how far a user has read, and nothing in the
-- schema recorded it. Verified before writing this: no `last_read`, `read_at` or
-- equivalent column in any table.
--
-- NO COUNTER COLUMN, and that is the whole design. Unread is
-- `greatest(channels.last_sequence - read_positions.sequence, 0)`, because the write
-- path already maintains `last_sequence` and chapter 2.2 made it the sequencing
-- authority. Three shapes measured for one page of 50 channels against 1,000,000
-- messages:
--
--     count rows past the read position    9.807 ms  11.109 ms  13.431 ms
--     a cached counter on the position      2.129 ms   1.928 ms   1.226 ms
--     last_sequence - read position         1.122 ms   4.426 ms   4.497 ms
--
-- The cached counter is no faster and adds a value that can go stale. What the
-- subtraction accepts is that a tombstoned message still occupies a sequence, so a
-- deleted message counts as one unread; counting rows instead is 10x the cost on the
-- query a client runs to render its first screen (research R5, FR-016).
--
-- environment_id IS DENORMALISED, AND channel_id ALREADY DETERMINES IT. The column is
-- here because the lane's guard watches tables that carry one, and a table without it
-- is a table the guard cannot refuse a cross-environment delete on. `members` is the
-- counter-example the previous chapter's migration names on its own constraint: it
-- has no environment_id, so the catalogue classifies it as `hop` — reached through a
-- foreign key — and no trigger protects it. A read position is per-user state that a
-- tenant's own operations mutate, so it takes the stronger classification.
--
-- AND THE GUARD ENTRY ARRIVES IN THIS SAME CHAPTER, not in a later audit. The rule
-- the instruments chapter set is that a table joins `sentinel.sql`'s array, gains its
-- bait, and gets its case in `guard.itest.ts` in the chapter that CREATES it —
-- because a name in that array without bait behind it installs a trigger that can
-- never match and reads, in every report, exactly like protection.
--
-- NO id COLUMN. The primary key is (channel_id, user_id) because that is what a read
-- position is. The guard's refusal message interpolates a key, and the endpoints
-- chapter installed `coalesce(to_jsonb(OLD) ->> 'id', to_jsonb(OLD)::text)` for
-- exactly the tables that have no `id` to interpolate.
CREATE TABLE read_positions (
    environment_id  UUID NOT NULL REFERENCES environments(id),
    channel_id      UUID NOT NULL REFERENCES channels(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    -- Advances forwards only. A write naming a lower sequence than the stored one is
    -- accepted and changes nothing, so a client replaying an old acknowledgement
    -- cannot move a user's unread count backwards. A value past
    -- channels.last_sequence is refused (FR-018): a position nothing can reach makes
    -- every later count wrong.
    sequence        BIGINT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT read_positions_channel_id_user_id_pk PRIMARY KEY (channel_id, user_id)
);
--> statement-breakpoint

-- A DELETED USER KEEPS THEIR ROW, and this column is what says so.
--
-- This is in no SRS clause. It arrived from designing FR-USR-05's deletion path and
-- finding nowhere to record the state. Three tables reference users(id) — messages,
-- members, and read_positions above — and the clause asks that a deleted user's
-- messages be preserved "as authored by a deleted user".
--
-- ON DELETE SET NULL WOULD SATISFY THE LETTER OF THAT AND BREAK DELIVERY.
-- `backfill.controller`'s `toFrame` drops senderless rows because `messageSchema`
-- requires `user`, so a NULL author makes a message invisible to every socket.
-- "Authored by a deleted user" and "authored by nobody" are different states and only
-- the first is deliverable. ON DELETE CASCADE deletes the messages the clause says to
-- keep. A separate `deleted_users` table is a second identity space for one flag
-- (research R7).
--
-- So deletion clears the profile fields, removes the memberships and read positions,
-- sets this, and touches no messages.
--
-- (environment_id, external_id) STAYS UNIQUE, which is why presenting the same
-- external id again reuses this row and clears this column (FR-030) rather than
-- creating a second identity for one person.
ALTER TABLE users
    ADD COLUMN deleted_at TIMESTAMPTZ;
