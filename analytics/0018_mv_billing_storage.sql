-- Chapter 4.16 — the third view into `daily_usage_billing`.
--
-- A MATERIALISED VIEW IS A TRIGGER ON FUTURE INSERTS (4.6), so it computes nothing about
-- rows already in its source. That chapter measured the consequence — a view created over
-- a populated table read 0 where the raw table read 56 — and concluded that a rollup
-- created late is permanently short.
--
-- **IT DOES NOT BITE HERE, AND ONLY BECAUSE `media_events` STARTS EMPTY.** `0016` creates
-- it in the same apply; there is no history to miss. That is the one circumstance under
-- which 4.6's finding is free, and it is worth writing down because the next person to add
-- a view will not have it.
--
-- `sumMap(map(kind, 1))` COUNTS UPLOADS BY KIND AND `sum(bytes_delta)` SUMS THE LEVEL'S
-- DELTAS. A rendition is not an upload — nobody uploaded it — so only `reserved` counts
-- toward FR-009, while every event's bytes count toward the level. FR-010 is the
-- requirement that those two answers stay different on purpose and identical everywhere.
CREATE MATERIALIZED VIEW IF NOT EXISTS relay_analytics.mv_billing_storage
TO relay_analytics.daily_usage_billing
AS SELECT
    environment_id,
    toDate(ts)                                              AS day,
    0                                                       AS messages,
    initializeAggregation('uniqState', CAST(NULL AS Nullable(UUID))) AS active_users_state,
    0                                                       AS stored_delta,
    0                                                       AS connection_minutes,
    sum(bytes_delta)                                        AS stored_bytes_delta,
    sumMap(map(kind, toUInt64(if(event = 'reserved', 1, 0)))) AS uploads_by_kind
FROM relay_analytics.media_events
GROUP BY environment_id, day
