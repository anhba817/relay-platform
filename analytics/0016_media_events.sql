-- Chapter 4.16 — the events DR-17 names, and the first thing to write into this database
-- about media at all.
--
-- *"Stored-bytes-per-tenant shall be maintained as a daily rollup summing `media_events`
-- deltas (uploaded/deleted)"* — the clause names this table, and `ingester/metering.ts`
-- already points at it in a comment: *"the same shape one table over."* One table over is
-- `message_events`, which holds **0 rows and has no producer**, so the shape being copied
-- has never carried data. This is the first time it will.
--
-- A SIGNED DELTA RATHER THAN A SAMPLED LEVEL, WHICH IS THE CLAUSE'S OWN CHOICE. A daily
-- sample needs something to run daily and this platform has no runner for a recurring job
-- (ADR-28 — no `schedule:` trigger, one hand-run script). A materialised view fires on
-- insert. What that costs is in the chapter: a sampled level is self-correcting and a
-- summed one is not, so one lost record is wrong for ever, by between 1 kB and 25 MB
-- depending which object it was.
CREATE TABLE IF NOT EXISTS relay_analytics.media_events
(
    environment_id  UUID,
    -- THE OBJECT, so a reconciliation can name what disagrees rather than only that
    -- something does. DR-17's comparison is per tenant; an operator's next question is
    -- which object, and a table that cannot answer it sends them to Postgres.
    media_id        UUID,
    -- `reserved`, `rejected`, `rendition`, `deleted`. A closed set in `@relay/protocol`
    -- and not a CHECK: migration 0018 of the operational schema made that argument for
    -- `rejected_reason` and it holds here — a constraint is a fourth thing to widen.
    event           LowCardinality(String),
    -- image / audio / video, for FR-009's per-kind counts. Present on EVERY record
    -- including `deleted`, so the view that builds the counts can reverse them with the
    -- same expression rather than a second one.
    kind            LowCardinality(String),
    -- SIGNED, AND CARRIED RATHER THAN DERIVED FROM `event`. `daily_usage_billing.stored_delta`
    -- is the counter-example one table over: its sign comes from
    -- `multiIf(event = 'created', 1, …)`, and its name has since read to a planner as
    -- though it counted bytes. A reader that infers the sign puts the rule in two places.
    --
    -- AND IT IS THE QUOTA'S QUANTITY (FR-002). `reserveMediaSlot` sums `declared_bytes`
    -- where `state <> 'rejected'`, so a `pending` object is already charged and the meter
    -- agrees by construction instead of by reconciliation.
    bytes_delta     Int64,
    -- WHEN IT BECAME TRUE, not when it was ingested. `DateTime64(3)` matches
    -- `message_events`; the publisher's field is `occurred_at` and the rename to `ts`
    -- happens in the shaper, which is the rename `shape.ts`'s header warns fails silently
    -- if it stops happening.
    ts              DateTime64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (environment_id, ts)
-- 90 DAYS, MATCHING `message_events` AND DR-09. The rollup outlives it, which is DR-09
-- and DR-10's split — and the rollup's own TTL is 25 months rather than absent, which is
-- what bounds a level accumulated from these deltas. `0010`'s comment says "No TTL" and
-- `0014` already corrected it; the chapter states the horizon rather than inheriting the
-- wrong half of that pair.
--
-- AND 4.2 MEASURED THAT THE TTL CUTS AT INSERT, not at merge: a count taken the moment a
-- load finishes shrinks overnight on its own.
TTL toDateTime(ts) + INTERVAL 90 DAY
