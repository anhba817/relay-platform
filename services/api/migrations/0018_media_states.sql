-- Chapter 4.13 — the states FR-MED-03 and FR-MED-04 name, and what the probe records.
--
-- THREE VALUES AND NOT MORE. Chapter 4.10 wrote the one-value version deliberately:
-- "`ready` and `rejected` arrive with the verification and scanning clauses; a CHECK that
-- accepted them now would be a schema claiming a state nothing can reach." This is that
-- chapter. The constraint's job is unchanged — a fourth value is still a write that fails,
-- which `0018`'s own red probe asserts by name.
--
-- `scanning` IS NOT ONE OF THEM. A worker that has picked up an object would like to say
-- so, and what it actually needs is a lease with a timeout, not a value somebody must
-- remember to clear after a crash. FR-MED-04 names two transitions and FR-MED-07 publishes
-- three states to clients; a fourth would have to be hidden from them or contracted for.
--
-- AND THIS FILE IS ONE-WAY ONCE ANYTHING REACHES A TERMINAL STATE. Restoring the narrow
-- constraint answers `check constraint "media_objects_state_check" … is violated by some
-- row` until the `ready` and `rejected` rows are deleted. ADR-16 makes migrations
-- forward-only, so that is a property rather than a fault — and it is the first thing a
-- local rollback meets.
ALTER TABLE media_objects DROP CONSTRAINT media_objects_state_check;
ALTER TABLE media_objects ADD CONSTRAINT media_objects_state_check
  CHECK (state IN ('pending', 'ready', 'rejected'));

-- WHAT THE WORKER LEARNED, IN COLUMNS RATHER THAN A JSONB BLOB. FR-MED-05's thumbnails
-- want dimensions and FR-MED-12 meters stored bytes; both are later chapters in this
-- movement and both want a number they can filter and sum. A blob makes each of those a
-- `->>` and a cast, which is the shape chapter 4.2 spent a chapter on.
--
-- EVERY ONE IS NULLABLE AND THAT IS THE RECORD OF WHICH QUESTIONS WERE ASKED. Dimensions
-- are null for audio, `duration_ms` for images, and all of them for an object that has not
-- been verified or was rejected before the probe ran. Chapter 4.10 made the same argument
-- for `user_id` and 4.11 then depended on it.
ALTER TABLE media_objects
  ADD COLUMN width           integer,
  ADD COLUMN height          integer,
  ADD COLUMN duration_ms     integer,
  -- THE FACTS BESIDE THE DECLARATION. `declared_bytes` and `mime_type` are what the caller
  -- said — 4.10's comment says so in as many words — and this chapter produces the first
  -- thing in the platform that knows better. Keeping both is what makes FR-MED-03's refusal
  -- auditable after the bytes are gone, because a rejected object's row is all that
  -- survives it.
  ADD COLUMN verified_bytes  bigint,
  ADD COLUMN verified_type   text,
  -- A CLOSED SET OF TWO, AND NOT A CHECK CONSTRAINT. `declaration_mismatch` and
  -- `scan_failed`, which FR-005 requires to be distinguishable. A CHECK here would be a
  -- fourth thing to widen every time a reason arrives; the set lives in the protocol
  -- package where the reader can see it.
  ADD COLUMN rejected_reason text;
