-- Chapter 4.19 — FR-MSG-07 says "immutable" and nothing enforced it.
--
-- "The system shall support editing message text, preserving the original sequence
-- number and recording an immutable edit history with timestamps."
--
-- That word has been in the SRS since before chapter 3.23 built the table, and it was a
-- description rather than a mechanism. Measured on the development lane before this
-- file, inside a transaction and rolled back so the probe did not rewrite a history the
-- next measurement reads:
--
--     update message_edits set prior_text='tampered' where …   -->  UPDATE 1
--     delete from message_edits where …                        -->  DELETE 1
--
-- Both verbs succeeded. `audit_log` has carried a guard since chapter 4.18 and this
-- table, which holds the same kind of evidence, had none.
--
-- AND IT IS THIS CHAPTER'S BUSINESS RATHER THAN A SEPARATE ONE, because the chapter's
-- product is a recoverable text: a recovered text the application can rewrite is not an
-- answer to *what did it say*, it is a note. The preservation and the enforcement ship
-- together or the first is worth less than FR-MSG-07 already claims.

-- WHY A TRIGGER AND NOT `REVOKE UPDATE, DELETE` — ADR-35, applied to a second table
-- rather than re-decided. The obvious mechanism is inert here: the api connects as
-- `relay`, which is a superuser, and a superuser is not subject to table privileges.
-- The grant would sit in this file and the table would stay mutable to the only program
-- that talks to it. A `BEFORE UPDATE OR DELETE` trigger fires for a superuser.
--
-- AND THE SCOPE IS PUBLISHED RATHER THAN IMPLIED. Two things still get through, measured
-- on `audit_log` at 4.18 and re-measured here rather than assumed to transfer:
--
--     set session_replication_role = replica;   -- every trigger in the session, off
--     drop trigger … on message_edits;          -- and then anything
--
-- So the claim is: the edit history is immutable to the application and to accident, and
-- it is not immutable to somebody holding the database password. This api holds that
-- password. ADR-35's reversal condition — a separate non-superuser role for the
-- application — is a deployment decision and would move this claim and NFR-SEC-10's
-- together.
--
-- CONSTITUTION IV, AND THIS IS NOT THE GUARD. `no-trigger-in-migrations.test.ts` forbade
-- every trigger in this directory until chapter 4.18 narrowed it to the sentinel guard by
-- name, and asserted the narrowing. The rule was wider than its reason: the guard rejects
-- the api's own legitimate sweeps, and this refuses writes the api must never make.
-- A second permitted trigger needs no change to that test, which is a thing to run rather
-- than to reason about (T034).
--
-- WHAT A ROW 22 AUTHOR NEEDS FROM THIS FILE. Erasure must destroy a user's words and
-- these rows hold them, so this trigger stands in its way — and it is the SECOND
-- obstacle, not the first. `message_edits_message_id_fkey` is `NO ACTION`, so a hard
-- delete of the message is refused by the foreign key before any trigger is consulted.
-- `audit_log` has one obstacle and this table has two. This chapter writes the collision
-- down and does not pre-solve it.
CREATE FUNCTION message_edits_refuse_write() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'message versions are append-only (FR-MSG-07)'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_edits_append_only
  BEFORE UPDATE OR DELETE ON message_edits
  FOR EACH ROW EXECUTE FUNCTION message_edits_refuse_write();
