-- DR-10: "materialised views shall maintain daily per-tenant rollups for metering, so
-- billing never scans raw events." SAD 6.2's view, with both its own name and its FROM
-- qualified -- an unqualified view over an unqualified source is two chances to land in
-- `default` instead of one.
--
-- IT HAS NO TTL AND THAT IS DELIBERATE (FR-003a). message_events expires at 90 days; this
-- keeps the day's figures for good, because metering must not lose history when raw
-- events do. It also counts rows the TTL deletes in the same INSERT -- the view fires
-- first -- so a comparison against the raw table has to name a window on both sides.
CREATE MATERIALIZED VIEW IF NOT EXISTS relay_analytics.daily_usage
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (environment_id, day)
AS SELECT
    environment_id,
    toDate(ts)            AS day,
    count()               AS messages,
    uniqState(user_id)    AS active_users_state
FROM relay_analytics.message_events
WHERE event = 'created'
GROUP BY environment_id, day
