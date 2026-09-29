-- Chapter 4.15 — FR-MED-05's last five words, which are the hard part of the clause.
--
-- "Stored as derived objects sharing the parent's lifecycle" reads like a storage note.
-- It is the only part of the clause that needed a migration, because two clauses already
-- shipped destroy an object nothing references, and a thumbnail is unreferenced by
-- construction — the message names the parent.
--
--   FR-MED-08  authorises through `channelsReferencingMediaIn`, which finds the channels
--              of messages whose attachments contain the id. A rendition appears in none,
--              so the delivery gate refuses it. That is the clause working as written.
--   FR-MED-10  hard-deletes unreferenced objects after 24 hours.
--
-- So a rendition is not a file that needs a home. It is a row the platform must agree to
-- treat as part of another row, at three separate doors — and before this file, nothing
-- in the schema could say that two rows were related at all.

-- ONE TABLE, NOT TWO. Every door that acts on media reads `media_objects`: the quota sum,
-- the delivery gate, the verdict handler, the reference lookup. A `media_renditions` table
-- would grow a second read or a UNION in each of them, and the two shapes share every
-- column that matters — an environment, a key, bytes, a mime type. FR-005 also requires
-- authorisation to be *the same predicate* as the parent's rather than a copy, and two
-- tables make one predicate into two.
ALTER TABLE media_objects
  -- NULL FOR EVERYTHING A CLIENT UPLOADED. Non-null exactly when this row exists because
  -- another one does.
  ADD COLUMN parent_id uuid,
  -- WHAT THIS DERIVED OBJECT IS. A closed set in `@relay/protocol` and deliberately NOT a
  -- CHECK constraint, which is migration 0018's argument for `rejected_reason`: a CHECK is
  -- a fourth thing to widen every time a kind arrives. One member today, `thumbnail`;
  -- `poster` is the video half and is not built (SRS 1.22, ADR-34).
  ADD COLUMN rendition text,
  -- ON THE **PARENT**, NOT ON THE RENDITION. FR-007 wants an allowed type that produces no
  -- rendition recorded as a value rather than as an absence, and the row that survives to
  -- be asked is the parent's. Null when nothing was attempted and when it worked.
  ADD COLUMN rendition_failed_reason text;

-- THE DISCRIMINATOR CANNOT DISAGREE WITH ITSELF. A row is an upload or a rendition; there
-- is no third thing for a reader to guess at.
ALTER TABLE media_objects ADD CONSTRAINT media_objects_rendition_pairing_check
  CHECK ((parent_id IS NULL) = (rendition IS NULL));

-- A RENDITION HAS NO LIFECYCLE OF ITS OWN, AND THIS IS WHAT KEEPS IT THAT WAY.
-- `state` is NOT NULL DEFAULT 'pending', so a rendition row must carry something; it
-- carries `ready`, written at insert. Without this constraint the column quietly becomes a
-- second state machine that only ever holds one value — which is exactly what 0018 argued
-- `scanning` out of being, in this same movement. The three states describe what the worker
-- learned about bytes a client uploaded, and nobody uploads a rendition.
ALTER TABLE media_objects ADD CONSTRAINT media_objects_rendition_state_check
  CHECK (rendition IS NULL OR state = 'ready');

-- CONSTITUTION I, GIVEN TO THE DATABASE INSTEAD OF TO A PREDICATE SOMEBODY MAINTAINS.
--
-- A plain `REFERENCES media_objects(id)` would let a rendition name a row in another
-- environment, because the environment is a second column and a single-column foreign key
-- never looks at it. The composite key cannot: `environment_id` has to match on both sides.
--
-- The unique index below is redundant with the primary key for uniqueness and exists only
-- so the composite key has something to point at — Postgres requires the referenced columns
-- to carry a unique constraint. That is its whole cost, and chapter 4.15 measures it.
ALTER TABLE media_objects ADD CONSTRAINT media_objects_id_environment_key
  UNIQUE (id, environment_id);

-- `ON DELETE CASCADE` DISCHARGES FR-003's DATABASE HALF FOR EVERY PATH, PRESENT AND FUTURE.
--
-- AND IT IS DORMANT TODAY, WHICH IS WORTH WRITING DOWN RATHER THAN DISCOVERING. **Nothing
-- in this platform deletes a `media_objects` row.** The one live deletion is the rejection
-- path, and it deletes BYTES and keeps the row on purpose — 0018 says "a rejected object's
-- row is all that survives it", because a refusal has to stay auditable after the object is
-- gone. This constraint becomes live when the erasure chapter (`docs/12` row 22, FR-MED-10
-- and FR-MOD-04) writes the first row deletion. Until then the only way to exercise it is a
-- direct DELETE, which is what the chapter's test does.
ALTER TABLE media_objects ADD CONSTRAINT media_objects_parent_fk
  FOREIGN KEY (parent_id, environment_id)
  REFERENCES media_objects (id, environment_id) ON DELETE CASCADE;

-- ONE RENDITION OF EACH KIND PER PARENT, WHATEVER CALLS THE INSERT TWICE (FR-010).
--
-- The verdict is already a compare-and-set, so a duplicate sweep never reaches the insert.
-- This goes in anyway: "the guard upstream means this cannot happen" is what five accounting
-- tests in chapter 4.14 were each protecting against.
--
-- AND IT DOES NOT TOUCH UPLOADED OBJECTS, WHICH WAS CHECKED RATHER THAN ASSUMED. Both
-- columns are NULL for every upload, and SQL treats NULLs as distinct in a unique
-- constraint — verified against postgres:16-alpine before this line was written: three
-- all-NULL rows accepted, a real duplicate refused by name. Had it gone the other way,
-- every upload after the first would have been refused by a constraint added for renditions.
--
-- AND IT IS A PARTIAL UNIQUE INDEX RATHER THAN A TABLE CONSTRAINT, WHICH WAS A MEASUREMENT
-- AND NOT A PREFERENCE. The first version of this file wrote `UNIQUE (parent_id, rendition)`
-- as a constraint. A btree indexes NULLs, so it covered all 6,646 rows and cost **168 kB**
-- against a 1,504 kB heap — to enforce uniqueness among the rows where `parent_id IS NOT
-- NULL`, of which there were none. Restricted to those rows it is **8,192 bytes** — a 21x
-- reduction — and it refuses exactly the same duplicates, which was re-run to check that
-- making it partial had not made it decorative.
CREATE UNIQUE INDEX media_objects_parent_rendition_key
  ON media_objects (parent_id, rendition) WHERE parent_id IS NOT NULL;

-- PARTIAL, FOLLOWING 0019's PRECEDENT IN THIS TABLE. It stays the size of the rendition
-- population rather than the size of `media_objects`, which is 6,535 rows of which 4 would
-- currently gain a thumbnail. Read by the delivery join and by the predicate that decides
-- what "unreferenced" means once renditions exist.
CREATE INDEX media_objects_parent_idx
  ON media_objects (parent_id) WHERE parent_id IS NOT NULL;
