-- Chapter 3.10 — monthly usage quotas (FR-RTL-05 to FR-RTL-08).
--
-- Chapter 3.8 built the per-minute limiter. This is the other half of FR-RTL and
-- the two are different problems wearing the same word: a rate limit is about
-- THIS SECOND and forgets, a quota is about THIS MONTH and must not. Everything
-- below follows from the second half of that sentence.
--
-- WHY A ROLL-UP AND NOT A QUERY OVER `messages`. Deriving usage on read is one
-- statement and needs no tables at all, and it is what this chapter argues
-- against. `messages` carries no `environment_id` — it hangs off `channels` — and
-- no index on `created_at`, so the month predicate is a FILTER applied after the
-- rows are read:
--
--     ->  Bitmap Heap Scan on messages m
--           Recheck Cond: (c.id = channel_id)
--           Filter: (created_at >= date_trunc('month', ...))
--
-- The work is proportional to everything the tenant has ever sent. At 507
-- messages it measures a quarter of a millisecond, which is why the argument is
-- the plan and not the clock.

-- ---------------------------------------------------------------------------
-- The policy: the column chapter 2.1 left empty.
-- ---------------------------------------------------------------------------
--
-- THERE IS NO NEW POLICY COLUMN, because `environments.quota_config` has been
-- sitting there since `0000_core_tables.sql` — declared in chapter 2.1, named in
-- SRS §6.1, and read by nothing for eighteen chapters. Chapter 3.8 was offered it
-- for rate-limit policy and refused, in prose, on the grounds that "the column is
-- named for quotas, quotas are a later chapter". This is that chapter.
--
-- Shape:
--
--     { "messages":     { "hard": 10000, "soft": 8000 },
--       "active_users": { "hard": null,  "soft": 500  } }
--
-- ABSENT AND NULL BOTH MEAN NO CAP. ZERO MEANS REFUSE EVERYTHING. That is the
-- same rule 0008 wrote for the limit columns, and jsonb keeps it expressible:
-- `#>> '{messages,hard}'` returns SQL NULL for an absent key and for a JSON null
-- alike, and the string `'0'` for zero. The distinction 3.8 needed nullable
-- columns for survives the move.
--
-- WHAT THE JSONB BUYS: chapter 3.11 adds connection-minutes and FR-MED-12 later
-- adds media bytes, and neither needs a table migration — a new dimension is a
-- new key.
--
-- WHAT IT COSTS, said plainly rather than discovered later: the shape below is
-- enforced by a CHECK that ENUMERATES the two dimensions, so a third one does
-- cost a one-line constraint change to keep the guarantee. A constraint that
-- validated any dimension would need `jsonb_each`, and a CHECK may not contain a
-- subquery —
--
--     ERROR:  cannot use subquery in check constraint
--
-- which is the restriction feature 030's R37 met from the other side, in a
-- trigger's WHEN clause. The alternative is a PL/pgSQL validator, and a procedural
-- function in a PRODUCT migration is a constitution VII argument this chapter has
-- not earned; feature 030's guard is exempt precisely because it is never a
-- migration.
--
-- The regex rather than a cast: `(… )::bigint` inside a CHECK throws on bad input
-- instead of rejecting the row, and a constraint that errors is worse than one
-- that refuses.

ALTER TABLE environments
  ADD CONSTRAINT environments_quota_config_shape CHECK (
    jsonb_typeof(quota_config) = 'object'
    AND (quota_config -> 'messages' IS NULL
         OR jsonb_typeof(quota_config -> 'messages') = 'object')
    AND (quota_config -> 'active_users' IS NULL
         OR jsonb_typeof(quota_config -> 'active_users') = 'object')
    AND (quota_config #>> '{messages,hard}' IS NULL
         OR quota_config #>> '{messages,hard}' ~ '^[0-9]+$')
    AND (quota_config #>> '{messages,soft}' IS NULL
         OR quota_config #>> '{messages,soft}' ~ '^[0-9]+$')
    AND (quota_config #>> '{active_users,hard}' IS NULL
         OR quota_config #>> '{active_users,hard}' ~ '^[0-9]+$')
    AND (quota_config #>> '{active_users,soft}' IS NULL
         OR quota_config #>> '{active_users,soft}' ~ '^[0-9]+$')
  );

-- ---------------------------------------------------------------------------
-- The roll-up.
-- ---------------------------------------------------------------------------
--
-- `period` IS STORED, NOT COMPUTED. It is the first day of the calendar month in
-- UTC, and storing it makes a lookup the whole primary key rather than a
-- predicate over a range — a month boundary becomes a different row instead of a
-- different filter. `services/api/src/quotas/period.ts` is the one definition of
-- which month an instant belongs to; nothing here repeats `date_trunc`.
--
-- THIS IS THE PROJECT'S FIRST `date` COLUMN, against 28 `timestamp` ones, and it
-- is half a primary key. Drizzle's `date` reads and writes `YYYY-MM-DD` strings,
-- so the TypeScript side hands strings across; a `Date` on one side of that
-- comparison and a string on the other is a row that cannot be found rather than
-- an error (research R7a).
--
-- `messages_sent` IS `bigint`, declared `{ mode: "number" }` in the schema like
-- the two bigints this project already has. It is a cumulative count on the hot
-- path, and an overflow here is a wrong bill rather than a wrapped counter.

CREATE TABLE usage_periods (
  environment_id uuid        NOT NULL REFERENCES environments(id),
  period         date        NOT NULL,
  messages_sent  bigint      NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, period),
  CONSTRAINT usage_periods_messages_sent_non_negative
    CHECK (messages_sent >= 0)
);

-- ---------------------------------------------------------------------------
-- The distinct-user membership.
-- ---------------------------------------------------------------------------
--
-- A message count is `+1`. A DISTINCT-USER COUNT IS NOT: incrementing it requires
-- knowing whether this user has already sent this period, which is a read. So the
-- row is the answer — one per user per period, written `ON CONFLICT DO NOTHING`
-- on every attributed send, and the count is an index-only scan over the key
-- prefix.
--
-- Bounded by the tenant's distinct users per month rather than by their traffic,
-- which is what makes it affordable and the reason it is a table and not a
-- counter. HyperLogLog in Redis is the textbook answer and is refused by FR-002:
-- a flush would erase the month.
--
-- A SEND WITH NO `user_id` WRITES NO ROW. A key-authenticated REST send is
-- unattributed by design since chapter 3.3, and an unattributed send counts
-- toward the message quota and toward no user.

CREATE TABLE usage_active_users (
  environment_id uuid        NOT NULL REFERENCES environments(id),
  period         date        NOT NULL,
  user_id        uuid        NOT NULL REFERENCES users(id),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, period, user_id)
);

-- ---------------------------------------------------------------------------
-- The outbox, a fourth time.
-- ---------------------------------------------------------------------------
--
-- Chapter 3.3 published events, 3.5 dispatched webhook deliveries, 3.9 sent
-- disablement emails. Each is a table whose claim predicate starts null, drained
-- by a relay, retried by falling due again. This is the fourth, and saying the
-- number out loud is the point: four concrete tables that look alike is a
-- pattern, one abstract table serving four purposes is a framework.
--
-- `webhook_disable_notifications` CANNOT BE REUSED — its `endpoint_id` is NOT
-- NULL and a quota crossing has no endpoint.
--
-- THE UNIQUE CONSTRAINT IS FR-015. "At most one email per threshold per quota per
-- period" is enforced by the schema rather than promised by the code that writes
-- it, so a concurrent double-crossing resolves to one row instead of two emails.
--
-- `quota` and `usage_at_crossing` are STORED rather than looked up at send time,
-- because the cap can change between the crossing and the delivery, and an email
-- saying "you have used 80% of 10,000" should mean the 10,000 that was true when
-- it happened.

CREATE TABLE quota_notifications (
  id                uuid        PRIMARY KEY,
  environment_id    uuid        NOT NULL REFERENCES environments(id),
  organisation_id   uuid        NOT NULL REFERENCES organisations(id),
  period            date        NOT NULL,
  dimension         text        NOT NULL,
  threshold         integer     NOT NULL,
  quota             bigint      NOT NULL,
  usage_at_crossing bigint      NOT NULL,
  crossed_at        timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz,
  last_error        text,
  CONSTRAINT quota_notifications_dimension_check
    CHECK (dimension IN ('messages', 'active_users')),
  CONSTRAINT quota_notifications_threshold_check
    CHECK (threshold IN (50, 80, 100)),
  CONSTRAINT quota_notifications_once_per_threshold
    UNIQUE (environment_id, period, dimension, threshold)
);

-- The claim predicate the relay drains on, matching chapter 3.9's shape.
CREATE INDEX quota_notifications_undelivered
  ON quota_notifications (crossed_at)
  WHERE delivered_at IS NULL;
