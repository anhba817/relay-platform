-- The billing rollup's backfill, and it exists for the reason `0009` does: a materialised
-- view is a trigger on future inserts, not a query over history. The corpus and the 154
-- connection records were both already in the store when `0011` and `0012` were created.
--
-- ONE STATEMENT, BOTH SOURCES, because the file may hold one and a UNION ALL is one.
INSERT INTO relay_analytics.daily_usage_billing
    (environment_id, day, messages, active_users_state, stored_delta, connection_minutes)
SELECT environment_id, toDate(ts) AS day,
       countIf(event = 'created')                                       AS messages,
       uniqState(user_id)                                               AS active_users_state,
       sum(multiIf(event = 'created', 1, event = 'deleted', -1, 0))::Int64 AS stored_delta,
       0                                                                AS connection_minutes
  FROM relay_analytics.message_events
 GROUP BY environment_id, day
UNION ALL
SELECT environment_id, toDate(minute) AS day,
       0                                       AS messages,
       uniqState(CAST(NULL AS Nullable(UUID))) AS active_users_state,
       0                                       AS stored_delta,
       count()                                 AS connection_minutes
  FROM (
    SELECT environment_id,
           toDateTime(arrayJoin(range(
               toUInt32(toStartOfMinute(ts - toIntervalMillisecond(duration_ms))),
               toUInt32(toStartOfMinute(ts)) + 60,
               60
           ))) AS minute
      FROM relay_analytics.connection_events
     WHERE event = 'closed' AND duration_ms IS NOT NULL
  )
 GROUP BY environment_id, day
