-- Hosted media, the slot: FR-MED-01 and FR-MED-02, movement V's first chapter.
--
-- A row here is a slot the platform AGREED TO, written before any byte exists.
-- ADR-13 says media bytes never transit Relay compute, so this table is the whole
-- of what the platform holds about an upload: what was declared, whose it is, and
-- where the object will live if it arrives.
--
-- A REFUSED REQUEST WRITES NOTHING. The three permanent refusals — the MIME type,
-- the per-kind size cap, the storage quota — happen before the insert, so this is
-- not a log of attempts. That matters because the storage quota is a SUM over this
-- table, and a table that recorded refusals would count bytes nobody was allowed
-- to upload.
--
-- `state` IS `pending` AND ONLY `pending`, ENFORCED. `ready` and `rejected` arrive
-- with FR-MED-03's verification and FR-MED-04's scan. A CHECK that accepted them
-- now would be a schema claiming states nothing in the platform can reach, which
-- is the shape chapter 4.8 found in a column with zero producers.

CREATE TABLE media_objects (
  id              uuid PRIMARY KEY,
  environment_id  uuid NOT NULL REFERENCES environments(id),
  -- NULLABLE ON PURPOSE: an API key has no user. FR-MED-06 later asks whether the
  -- sender uploaded it, and cannot ask that if absence is written as anything else.
  user_id         uuid REFERENCES users(id),
  filename        text NOT NULL,
  mime_type       text NOT NULL,
  declared_bytes  bigint NOT NULL,
  state           text NOT NULL DEFAULT 'pending',
  object_key      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT media_objects_state_check CHECK (state = 'pending'),
  CONSTRAINT media_objects_declared_bytes_check CHECK (declared_bytes > 0)
);

-- The storage quota reads this: `sum(declared_bytes)` for one environment, taken
-- inside the same transaction that inserts the next row.
CREATE INDEX media_objects_environment_idx ON media_objects (environment_id);

-- THE SENTINEL GUARD IS NOT SET UP HERE, AND THAT IS NOT AN OVERSIGHT. The guard
-- lives in `packages/test-harness/src/sentinel.sql`, which is lane infrastructure
-- rather than schema: this table joins its array there, together with the bait
-- `plant()` leaves and the case in `guard.itest.ts`. The three go together — a name
-- in the array with no bait installs a trigger that can never match, and reads
-- exactly like protection.
--
-- The array's own rule is that a table joins in the chapter that creates it. That
-- rule is not what the tree does, and it is worth measuring rather than repeating:
-- SEVEN of the TWELVE tables carrying `environment_id` are guarded today. `api_keys`
-- and the four webhook tables are not. This one joins; the five are filed.
