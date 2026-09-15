-- The message-sourced half of the billing rollup: same expressions as
-- `0007_mv_messages.sql`, one dimension coarser. Two views over one source is not a
-- duplication to factor out -- a materialised view writes to exactly one target, so a second
-- target needs a second view, and ClickHouse offers no other shape.
CREATE MATERIALIZED VIEW IF NOT EXISTS relay_analytics.mv_billing_messages
TO relay_analytics.daily_usage_billing
AS SELECT
    environment_id,
    toDate(ts)                               AS day,
    countIf(event = 'created')               AS messages,
    uniqState(user_id)                       AS active_users_state,
    sum(multiIf(event = 'created', 1, event = 'deleted', -1, 0))::Int64 AS stored_delta
FROM relay_analytics.message_events
GROUP BY environment_id, day
