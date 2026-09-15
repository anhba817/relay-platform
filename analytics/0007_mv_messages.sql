-- FR-001b. The message-sourced half of the rollup: messages sent, unique active users, and
-- the stored-count delta.
--
-- ITS SOURCE HAS NO PRODUCER, AND THE VIEW IS BUILT ANYWAY. Measured at this chapter's
-- opening: `message_events` holds 0 rows while `api_requests` holds 11,683 and
-- `connection_events` 154. The table appears in ZERO files under `services/`; its only
-- writer is `scripts/scale/load-analytics.mjs`, a batch loader that reads Postgres through
-- ClickHouse's `postgresql()` function. So DR-10's "billing never scans raw events" has been
-- satisfied by a rollup over a table that receives no events.
--
-- The view exists so the rollup is complete the day something writes that table, and so
-- that a loaded corpus has something to flow through -- a corpus passing through a rollup
-- with no message view proves nothing. Building the producer is a send-path change on the
-- busiest path in the platform and is not this chapter.
--
-- IT NAMES ONLY ITS OWN THREE COLUMNS. `connection_minutes` is omitted and arrives at its
-- type's zero for `SummingMergeTree` to add. Measured (baseline.txt): an omitted
-- `AggregateFunction` column reads back through `uniqMerge` as 0 rather than throwing.
CREATE MATERIALIZED VIEW IF NOT EXISTS relay_analytics.mv_daily_usage_messages
TO relay_analytics.daily_usage_v2
AS SELECT
    environment_id,
    channel_id,
    toDate(ts)                               AS day,
    countIf(event = 'created')               AS messages,
    uniqState(user_id)                       AS active_users_state,
    -- `edited` CONTRIBUTES 0, AND THAT IS A DECISION rather than an omission: an edit
    -- changes what a message says and not whether it is stored. The probe behind this
    -- carried an edit row for exactly that reason.
    sum(multiIf(event = 'created', 1, event = 'deleted', -1, 0))::Int64 AS stored_delta
FROM relay_analytics.message_events
GROUP BY environment_id, channel_id, day
