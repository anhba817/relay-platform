-- Chapter 3.15 — a member's role, and a deleted user who is still an author.
--
-- FR-CHN-04 has asked for channel member roles since the SRS was written and
-- `members` has been `(channel_id, user_id, joined_at)` the whole time. Chapter
-- 3.12's traceability map recorded the clause as delivered, described it with a
-- paraphrase belonging to FR-CHN-06, and was corrected while chapter 3.15 was
-- being specified.
--
-- ITS OWN CHECK CONSTRAINT, AND NOT THE ONE THAT ALREADY EXISTS. `memberships`
-- has carried `CHECK (role IN ('owner','admin','member'))` since chapter 3.1 —
-- that is FR-TEN-07, a human's role in an ORGANISATION. FR-CHN-04's channel
-- roles are 'owner', 'moderator', 'member'.
--
-- Different tables, different subjects, ONE WORD DIFFERENT. A migration that
-- reused the organisation constraint here would accept `admin` on a channel
-- member, refuse `moderator`, and look correct in review. Both constraints now
-- carry a comment naming the other, because a warning on one side of a trap is
-- a warning the next person does not find (research R8).
--
-- DEFAULT 'member', which is what lets chapter 3.13's `addMember` keep working
-- unchanged and gives every existing row a value the CHECK accepts. The
-- member-add endpoint takes an optional role per entry (FR-011b) so a member
-- can be created with one rather than only changed into one.
ALTER TABLE members
    ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
--> statement-breakpoint

ALTER TABLE members
    ADD CONSTRAINT members_role_check CHECK (role IN ('owner','moderator','member'));
--> statement-breakpoint

-- A DELETED USER KEEPS THEIR ROW, and this column is what says so.
--
-- This is in no SRS clause. It arrived from designing FR-USR-05's deletion path
-- and finding nowhere to record the state. Three tables reference users(id) —
-- messages, members, usage_active_users — and the clause asks that a deleted
-- user's messages be preserved "as authored by a deleted user".
--
-- ON DELETE SET NULL WOULD SATISFY THE LETTER OF THAT AND BREAK DELIVERY.
-- `backfill.controller`'s `toFrame` drops senderless rows because
-- `messageSchema` requires `user`, so a NULL author makes a message invisible
-- to every socket. "Authored by a deleted user" and "authored by nobody" are
-- different states and only the first is deliverable. ON DELETE CASCADE deletes
-- the messages the clause says to keep. A separate `deleted_users` table is a
-- second identity space for one flag (research R7).
--
-- So deletion clears the profile fields, removes the memberships and read
-- positions, sets this, and touches no messages and no usage_active_users rows —
-- that table is billing history and does not vanish with a profile (FR-029).
--
-- (environment_id, external_id) STAYS UNIQUE, which is why presenting the same
-- external id again reuses this row and clears this column (FR-030) rather than
-- creating a second identity for one person.
ALTER TABLE users
    ADD COLUMN deleted_at TIMESTAMPTZ;
