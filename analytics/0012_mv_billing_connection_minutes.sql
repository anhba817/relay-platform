-- The connection half of the billing rollup. A connection has no channel, so this view and
-- `0008_mv_connection_minutes.sql` differ only in their target: the channel-keyed table
-- receives the zero UUID in that column and this one has no such column to fill.
CREATE MATERIALIZED VIEW IF NOT EXISTS relay_analytics.mv_billing_connection_minutes
TO relay_analytics.daily_usage_billing
AS SELECT
    environment_id,
    toDate(minute)   AS day,
    1::UInt64        AS connection_minutes
FROM (
    SELECT
        environment_id,
        toDateTime(arrayJoin(range(
            toUInt32(toStartOfMinute(ts - toIntervalMillisecond(duration_ms))),
            toUInt32(toStartOfMinute(ts)) + 60,
            60
        ))) AS minute
    FROM relay_analytics.connection_events
    WHERE event = 'closed' AND duration_ms IS NOT NULL
)
