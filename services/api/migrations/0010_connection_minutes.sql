-- Chapter 3.11 — connection-minutes, the third dimension of FR-RTL-05.
--
-- Chapter 3.10 metered messages sent and distinct active users and stopped
-- there, because those two are the same kind of problem and this one is not.
-- Messages and users were already rows: `messages.user_id` has been in
-- `0000_core_tables.sql` since Part 2, so counting them was an aggregation
-- question answered inside a transaction the api already owned.
--
-- A CONNECTION IS NOT A ROW ANYWHERE. Nothing records it, and the only process
-- that can see one is the gateway, which owns no tables (ADR-05) and — until
-- this chapter — no identity of its own either. So the subject is not counting.
-- It is metering from a service that cannot write: what it has to say, how
-- often, and what happens to the number when the thing saying it dies
-- mid-sentence.
--
-- THE UNIT IS A WALL-CLOCK MINUTE BUCKET, CHARGED PER CONNECTION. A five-second
-- socket costs one minute; a socket open from 00:00:59 to 00:01:01 costs two; a
-- hundred concurrent sockets open for one minute cost a hundred. `docs/04-srs.md`
-- records "does connection-minute metering need per-second precision?" as an open
-- question addressed to Product and Billing; this is the answer, and it charges
-- reconnect churn, which summing seconds does not.

-- ---------------------------------------------------------------------------
-- The policy: the one-line change chapter 3.10 promised, priced.
-- ---------------------------------------------------------------------------
--
-- 0009 said out loud what a third dimension would cost:
--
--     chapter 3.11 adds connection-minutes and FR-MED-12 later adds media
--     bytes, and neither needs a table migration — a new dimension is a new
--     key … the shape below is enforced by a CHECK that ENUMERATES the two
--     dimensions, so a third one does cost a one-line constraint change
--
-- It is three clauses, not one line, and there is no `ALTER CONSTRAINT` for a
-- CHECK expression, so the whole constraint is dropped and rebuilt. The
-- prediction was right about the shape and light about the size; the chapter
-- counts what it actually cost rather than quoting what it was told it would.

ALTER TABLE environments
  DROP CONSTRAINT environments_quota_config_shape;

ALTER TABLE environments
  ADD CONSTRAINT environments_quota_config_shape CHECK (
    jsonb_typeof(quota_config) = 'object'
    AND (quota_config -> 'messages' IS NULL
         OR jsonb_typeof(quota_config -> 'messages') = 'object')
    AND (quota_config -> 'active_users' IS NULL
         OR jsonb_typeof(quota_config -> 'active_users') = 'object')
    AND (quota_config -> 'connection_minutes' IS NULL
         OR jsonb_typeof(quota_config -> 'connection_minutes') = 'object')
    AND (quota_config #>> '{messages,hard}' IS NULL
         OR quota_config #>> '{messages,hard}' ~ '^[0-9]+$')
    AND (quota_config #>> '{messages,soft}' IS NULL
         OR quota_config #>> '{messages,soft}' ~ '^[0-9]+$')
    AND (quota_config #>> '{active_users,hard}' IS NULL
         OR quota_config #>> '{active_users,hard}' ~ '^[0-9]+$')
    AND (quota_config #>> '{active_users,soft}' IS NULL
         OR quota_config #>> '{active_users,soft}' ~ '^[0-9]+$')
    AND (quota_config #>> '{connection_minutes,hard}' IS NULL
         OR quota_config #>> '{connection_minutes,hard}' ~ '^[0-9]+$')
    AND (quota_config #>> '{connection_minutes,soft}' IS NULL
         OR quota_config #>> '{connection_minutes,soft}' ~ '^[0-9]+$')
  );

-- ---------------------------------------------------------------------------
-- The roll-up gains a third figure.
-- ---------------------------------------------------------------------------
--
-- `bigint`, for the reason 0009 gave `messages_sent`: a cumulative count on a
-- billing path, where an overflow is a wrong bill rather than a wrapped counter.
-- Concretely — a tenant holding ten thousand sockets continuously accrues 5.26
-- BILLION connection-minutes a year, and `integer` tops out at 2,147,483,647,
-- about five months in.

ALTER TABLE usage_periods
  ADD COLUMN connection_minutes bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT usage_periods_connection_minutes_non_negative
    CHECK (connection_minutes >= 0);

-- ---------------------------------------------------------------------------
-- The state that makes a repeated report free.
-- ---------------------------------------------------------------------------
--
-- A REPORT SAYS WHAT A CONNECTION HAS CONSUMED IN TOTAL, not what it consumed
-- since last time, and that one decision removes the retry buffer the gateway
-- would otherwise need. A lost report is repaired by the next one, because the
-- next one carries the same total plus whatever accrued. A repeated one credits
-- `max(0, reported - credited) = 0`. A report that cannot be delivered is
-- DROPPED rather than queued — the gateway keeps no outbox, which is the right
-- amount of durable state for a service designed to hold none.
--
-- WHY NOT ONE ROW PER MINUTE. That is the naive dedup key: remember which
-- minutes have been credited. At a thousand concurrent sockets it is
-- 1,000 x 43,200 = 43.2 MILLION rows a month. This table is proportional to
-- distinct connections instead — chapter 3.10 made exactly this trade for
-- distinct users and bounded it by users rather than by traffic.
--
-- `connection_id` ALONE WOULD BE UNIQUE — it is a `randomUUID()` minted by the
-- gateway — but `period` is in the key because a connection open across a month
-- boundary owes minutes to two periods and each is credited independently.
--
-- A CONNECTION MAY NOT CHANGE ENVIRONMENT. `environment_id` is written by the
-- first report and never updated; a later report naming a different one is
-- refused with a 409 rather than reconciled. A connection moving tenants is
-- either a bug or an attempt, and constitution I makes that a correctness
-- question rather than a data-quality one.
--
-- NO SECONDARY INDEX, and that is a decision. A first draft added
-- `(environment_id, period)`; nothing reads it. The credit path looks a row up
-- by primary key and the figure an operator reads comes from `usage_periods`.
-- The one job that would have used it is pruning a finished period, which this
-- chapter declines — so nothing prunes this table, and it grows at roughly the
-- tenant's distinct connections per period: about 720,000 rows a month for a
-- thousand sockets turning over hourly. Written down here rather than
-- discovered by whoever opens the table first.

CREATE TABLE usage_connections (
  connection_id  uuid        NOT NULL,
  period         date        NOT NULL,
  environment_id uuid        NOT NULL REFERENCES environments(id),
  minutes        bigint      NOT NULL DEFAULT 0,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, period),
  CONSTRAINT usage_connections_minutes_non_negative CHECK (minutes >= 0)
);

-- ---------------------------------------------------------------------------
-- A third dimension in an existing column.
-- ---------------------------------------------------------------------------
--
-- No fifth table. Chapter 3.10 said "four concrete tables that look alike is a
-- pattern, one abstract table serving four purposes is a framework", and a third
-- dimension in the fourth table is neither. `quota_notifications_once_per_threshold`
-- already keys on `(environment_id, period, dimension, threshold)`, so
-- at-most-one-email-per-threshold holds for the new dimension without a line of
-- code.

ALTER TABLE quota_notifications
  DROP CONSTRAINT quota_notifications_dimension_check;

ALTER TABLE quota_notifications
  ADD CONSTRAINT quota_notifications_dimension_check
    CHECK (dimension IN ('messages', 'active_users', 'connection_minutes'));
