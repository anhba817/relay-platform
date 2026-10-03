-- Chapter 4.19 — the text a message held when it was deleted, and why it was never kept.
--
-- FR-MOD-01 asks for "any channel's complete history, including tombstones and edit
-- history, via API key". Both of its nouns were built in chapter 3.23 and the join
-- between them loses exactly one version, every time:
--
--     sent          "will be edited"
--     edit 1        "edited once"          message_edits <- "will be edited"
--     edit 2        "edited twice"         message_edits <- "edited once"
--     DELETE        204                    message_edits <- nothing
--
--     GET …/edits   two rows. "edited twice" is in no table.
--
-- An edit records the text it REPLACED; a deletion recorded nothing. So a message
-- deleted after N edits left N recoverable texts out of the N+1 that existed, and a
-- message deleted with no edits left zero of one. Measured on the development lane
-- before this file: 4,864 tombstones, every one of them missing its final text, and
-- 3,610 of those with no version row at all.
--
-- FR-MSG-08 IS THE CLAUSE, NOT A NEW ONE. "Hard deletion shall occur only via the
-- compliance deletion endpoint." Losing a version at deletion is a hard deletion
-- performed by the moderation path, which that sentence reserves for erasure.
--
-- WHAT THIS FILE DOES NOT DO: make the table immutable. That is `0023`, and the two are
-- separate files because `migrate.ts` records `schema_migrations.version` BY FILENAME
-- WITH NO CHECKSUM — a trigger appended to this file after it had applied would never
-- run on a machine that already ran it, while the ledger reported the migration done.
-- The order between them is load-bearing in the other direction too: the backfill below
-- is an UPDATE on `message_edits`, and `0023`'s trigger refuses exactly that. Filenames
-- apply in order, so `0023` is the only safe number for it.

-- NULLABLE FIRST, AND THE ORDER IS THE WHOLE OF IT. `ADD COLUMN … NOT NULL` with no
-- default fails on a table that already holds rows, and this one holds 4,863. Three
-- statements — add, backfill, constrain — rather than one that cannot run.
ALTER TABLE message_edits ADD COLUMN ended_by text;

-- EVERY EXISTING ROW IS AN EDIT, by construction and not by assumption: until this
-- chapter the only writer of this table was `editMessage`, and a deletion wrote nothing.
-- That is the defect the chapter exists to fix and it is also what makes the backfill
-- exact — there is no row here whose provenance is in doubt.
--
-- AND IT RECOVERS NOTHING. The 4,864 messages already deleted lost their final text when
-- they were deleted; no value of this column brings it back. The chapter publishes that
-- boundary rather than implying the history is complete backwards.
UPDATE message_edits SET ended_by = 'edit';

-- REQUIRED, AND THE COST WAS COUNTED BEFORE IT WAS CHOSEN: two insert sites, one of
-- which this chapter writes. `repository.ts` argues both sides of this in a comment of
-- its own — `attachments` is required *so the compiler names the sites*, while
-- `edited_at?` is optional for write-path convenience, which that same comment calls
-- "exactly what made the attachments chapter's `internalSendResponseSchema` a break
-- waiting to happen". Two sites is not a convenience worth buying.
ALTER TABLE message_edits ALTER COLUMN ended_by SET NOT NULL;

-- TWO VALUES AND NO DEFAULT. A default lets a writer stay silent, and the rule this
-- column exists for is that a row cannot be silent about which happened.
--
-- WHY THERE IS NO THIRD. A message's text stops being current for exactly two reasons on
-- this platform: a later edit replaced it, or a deletion removed it. Nothing else writes
-- `messages.text`. Retention (FR-MOD-06) and erasure (FR-MOD-04) are the two candidates
-- for a third and both DESTROY the row rather than ending a version, so neither produces
-- one. A third value would mean the platform had grown a fourth way for a text to stop
-- being current, and the clause that licensed it would say which — a clause, not a
-- column default.
ALTER TABLE message_edits
  ADD CONSTRAINT message_edits_ended_by_check CHECK (ended_by IN ('edit', 'deletion'));
