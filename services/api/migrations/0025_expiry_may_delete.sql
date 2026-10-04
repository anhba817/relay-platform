-- CHAPTER 4.20 — the one legitimate deleter, named in the trigger that refuses everyone
-- else. ADR-36's second decision.
--
-- BOTH CHANGES ARE IN ONE FILE BECAUSE THEY ARE ONE DECISION, and separating them would
-- publish a state nobody wants: a cascade without the exception deletes nothing and
-- fails louder than before, because the generated child DELETE hits the trigger.
--
-- THE PINCER, MEASURED IN ROLLED-BACK TRANSACTIONS AGAINST THE REAL SCHEMA. 5,495
-- messages own a version row and not one of them could be hard-deleted:
--
--   delete the message            ERROR  message_edits_message_id_fkey
--   delete the versions first     ERROR  message versions are append-only (FR-MSG-07)
--   ON DELETE CASCADE             ERROR  the same trigger, and the error names the
--                                        statement the cascade generated:
--                                        DELETE FROM ONLY "public"."message_edits"
--                                          WHERE $1 OPERATOR(pg_catalog.=) "message_id"
--   control: no version rows      DELETE 1
--
-- THE THIRD LINE IS THE ONE THAT SHAPES THIS FILE. A cascade is not a privileged path —
-- it issues an ordinary `DELETE` and a row-level trigger fires on it. So the cascade
-- alone does not help, and the exception alone leaves the foreign key refusing the
-- parent. Both, or neither.
--
-- THE ONLY THING THAT WORKED UNCHANGED WAS `SET session_replication_role = replica`,
-- which is the hole ADR-35 published as the limit of its own guarantee. Using it here
-- would make this platform's retention sweep the first caller of a bypass the previous
-- chapter documented as the reason its claim is scoped — and it disables EVERY trigger
-- in the session, which is wider than one table and one verb.

-- THE CASCADE. A version row must not outlive its message, and that invariant belongs
-- in the schema rather than in an ordered two-step delete somebody maintains in
-- application code — which is the distinction chapter 4.15 drew when it gave a
-- rendition's reachability to a composite foreign key rather than to a predicate.
ALTER TABLE "message_edits"
  DROP CONSTRAINT "message_edits_message_id_fkey";
ALTER TABLE "message_edits"
  ADD CONSTRAINT "message_edits_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;

-- THE EXCEPTION, AND IT NAMES ONE VERB ON ONE TABLE.
--
-- `TG_OP = 'DELETE'` IS PART OF THE CONDITION, NOT DECORATION. An UPDATE stays refused
-- with the flag set, because expiry destroys a row and never rewrites one: the
-- immutability of a version's CONTENT is not what this chapter gives up. Measured in
-- all three directions rather than the one that passes:
--
--     UPDATE, flag set           refused
--     DELETE child, flag unset   refused
--     DELETE message, flag set   DELETE 1, and the child rows go 1 -> 0
--
-- `current_setting(…, true)` TAKES THE MISSING-GUC ARM. Unset, it returns NULL, and
-- `NULL = 'on'` is NULL rather than TRUE — so there is no default to install and no
-- exception when the setting has never been touched.
--
-- WHAT THE FLAG IS WORTH IS THE WORD `LOCAL`, AND BOTH WAYS OF GETTING IT WRONG ARE
-- SILENT. Set without `LOCAL` the flag outlives its transaction on a pooled connection
-- and every later request can delete version rows — measured, `DELETE 1` on a
-- subsequent unrelated transaction. `SET LOCAL` outside a transaction block is a
-- WARNING rather than an error, leaves the flag unset, and every cascade is refused in
-- a way indistinguishable from the trigger doing its job. `Repository.destroyMessages`
-- is the only setter and `retention.itest.ts` asserts the flag's VALUE inside the same
-- transaction as the delete.
--
-- WHAT THIS COSTS, AND IT IS A PUBLISHED GUARANTEE. ADR-35 scoped `audit_log`'s
-- immutability as *to the application and to accident, and not to somebody holding the
-- database password*, and chapter 4.19 applied that scope to this table. After this
-- migration the scope for `message_edits` is *to the application EXCEPT ONE NAMED PATH,
-- and to accident* — and the named path is auditable in a way `session_replication_role`
-- is not: the condition is here, in a migration, inside the fence chain, naming exactly
-- one verb on one table. Constitution VII makes an accepted ADR immutable, so this is
-- ADR-36 superseding ADR-35's scope clause rather than an edit to it.
CREATE OR REPLACE FUNCTION message_edits_refuse_write() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('relay.expiring', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'message versions are append-only (FR-MSG-07)'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
