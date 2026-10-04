-- CHAPTER 4.20 — a retention policy is three values and an absence.
--
-- `environments.retention_days` HAS EXISTED SINCE CHAPTER 2.1 AND NOTHING HAS EVER SET
-- IT: 0 of 33,051 rows, measured at the open. The column was declared with the tenancy
-- schema and named in SRS §6.1 and SAD §6.1, and seventeen chapters read past it. So
-- this migration adds no column; it bounds the one that is there and indexes the two
-- reads the sweep makes.
--
-- WHY A CHECK AND NOT A RANGE. FR-MOD-06 enumerates 30 / 90 / 365 days / indefinite
-- rather than describing a bound, so `45` is not a stricter policy a customer chose —
-- it is a value nothing in the specification licenses, and a sweep acting on it would
-- be enforcing a promise nobody made. NULL is indefinite, which is the column's own
-- existing spelling for it rather than a fourth sentinel.
--
-- IT CANNOT FAIL ON EXISTING DATA, which is the only reason it is safe to add without
-- a backfill: the constraint validates against zero non-null values.
ALTER TABLE "environments"
  ADD CONSTRAINT "environments_retention_days_check"
  CHECK ("retention_days" IS NULL OR "retention_days" IN (30, 90, 365));

-- THE ENUMERATION THE SWEEP MAKES FIRST, AND IT IS A SEQ SCAN WITHOUT THIS.
--
-- Measured: `SELECT id, retention_days FROM environments WHERE retention_days IS NOT
-- NULL` is a Seq Scan of 33,051 rows at 546 buffers and 1.346 ms, `Rows Removed by
-- Filter: 33050` — paid on EVERY sweep, including today's overwhelmingly common case
-- where the answer is the empty set. With this index it is an Index Scan at 1 buffer
-- and 0.018 ms.
--
-- PARTIAL, AND THAT IS WHY IT IS 8,192 BYTES. A btree over the unfiltered column would
-- index 33,051 NULLs; over `WHERE retention_days IS NOT NULL` it indexes none of them.
-- Chapter 4.15 measured the same shape at the same size for the same reason, when
-- `UNIQUE (parent_id, rendition)` as a table constraint came out 21x too big.
CREATE INDEX "environments_retention_policy"
  ON "environments" ("id") WHERE "retention_days" IS NOT NULL;

-- THE PAGE THE SWEEP READS, AND WITHOUT THIS THE AGE PREDICATE NEVER REACHES AN INDEX.
--
-- `messages` carried four indexes before this one — its primary key, `(channel_id,
-- sequence)`, `messages_idem` and the attachments GIN — and nothing for `created_at`.
-- So the sweep's own predicate landed in a `Filter:` with `Rows Removed by Filter: 102`
-- per channel, and its cost was linear in the tenant's TOTAL message count rather than
-- in the number of messages that had expired.
--
-- MEASURED BOTH WAYS, because chapter 4.1 added the index its query obviously needed
-- and bought a gap inside the run-to-run spread for +49% storage:
--
--     without   73 buffers · 4.226 ms · created_at in a Filter
--     with      38 buffers · 0.141 ms · created_at in the Index Cond:
--               ((channel_id = c.id) AND (created_at < now() - '30 days'))
--     cost      7,992 kB on a 24 MB table; the table's indexes go 22 MB -> 30 MB
--
-- 4.1's warning does not bite here and the reason is the plan rather than the ratio:
-- the predicate moves from `Filter` to `Index Cond`, which is the question chapter 4.18
-- says to ask. A partial index is not available — the bound moves with the policy and
-- with the clock, so there is no constant to put in a WHERE.
--
-- AND IT IS WHAT MAKES THE KEYSET POSSIBLE. The sweep pages on `(channel_id,
-- created_at)`; chapter 4.13's sweep read one page with an offset and its head never
-- moved, so an object nobody uploaded to stayed `pending` for ever.
CREATE INDEX "messages_channel_created"
  ON "messages" ("channel_id", "created_at");
