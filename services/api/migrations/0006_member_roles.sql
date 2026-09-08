-- A member's role.
--
-- FR-CHN-04 has asked for channel member roles since the SRS was written and
-- `members` has been `(channel_id, user_id, joined_at)` the whole time. The
-- isolation harness's traceability map recorded the clause as delivered,
-- described it with a paraphrase belonging to FR-CHN-06, and was corrected while
-- this chapter was being specified.
--
-- ITS OWN CHECK CONSTRAINT, AND NOT THE ONE THAT ALREADY EXISTS. `memberships`
-- has carried `CHECK (role IN ('owner','admin','member'))` since the tenancy
-- chapter — that is FR-TEN-07, a human's role in an ORGANISATION. FR-CHN-04's
-- channel roles are 'owner', 'moderator', 'member'.
--
-- Different tables, different subjects, ONE WORD DIFFERENT. A migration that
-- reused the organisation constraint here would accept `admin` on a channel
-- member, refuse `moderator`, and look correct in review. Both constraints now
-- carry a comment naming the other, because a warning on one side of a trap is
-- a warning the next person does not find (research R8).
--
-- DEFAULT 'member', which is what lets the channel endpoints' `addMember` keep
-- working unchanged and gives every existing row a value the CHECK accepts. The
-- member-add endpoint takes an optional role per entry (FR-011b) so a member
-- can be created with one rather than only changed into one.
--
-- ROLES ONLY, AND THE ORIGINAL MIGRATION CARRIED MORE. `users.deleted_at` was
-- in the same file, added while designing FR-USR-05's deletion path — and that
-- path is the next chapter's, along with `read_positions` and
-- `channels.last_activity_at`. Two migrations split by subject rather than by
-- chapter meant this one could not be applied without the other, and the other
-- held nothing this chapter uses.
ALTER TABLE members
    ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
--> statement-breakpoint

ALTER TABLE members
    ADD CONSTRAINT members_role_check CHECK (role IN ('owner','moderator','member'));
