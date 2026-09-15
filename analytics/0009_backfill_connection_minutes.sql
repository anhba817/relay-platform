-- A MATERIALISED VIEW IS A TRIGGER ON FUTURE INSERTS, NOT A QUERY OVER HISTORY.
--
-- Measured the moment `0008` was applied: the rollup answered **0** connection-minutes while
-- the same expansion run directly against `connection_events` answered **56**, over 55 close
-- records that were already in the table. One new close inserted afterwards moved the rollup
-- to 2 and left the other 154 rows at 0. The view was not broken -- it had never seen them.
--
-- SO DR-10's "billing never scans raw events" IS EMPTY WITHOUT THIS FILE. Any deployment
-- applying the migration to a store that already holds data gets a metering rollup that knows
-- only what arrived after the migration, and nothing in the schema says so.
--
-- THE RACE, NAMED RATHER THAN HIDDEN. Rows inserted between `0008` creating the view and this
-- statement running are counted TWICE: once by the view, once here. `apply.mjs` runs the two
-- files milliseconds apart in one sorted pass, and a migration runs against an idle store, so
-- the window is small -- but small is not zero. In a live system the correct order is: create
-- the view, read the source's watermark, backfill strictly below it. That is a sentence about
-- operations rather than a line of SQL, which is why it is here as a comment.
INSERT INTO relay_analytics.daily_usage_v2
    (environment_id, channel_id, day, messages, active_users_state, stored_delta, connection_minutes)
SELECT
    environment_id,
    toUUID('00000000-0000-0000-0000-000000000000') AS channel_id,
    toDate(minute)                                 AS day,
    0                                              AS messages,
    uniqState(CAST(NULL AS Nullable(UUID)))        AS active_users_state,
    0                                              AS stored_delta,
    count()                                        AS connection_minutes
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
GROUP BY environment_id, day
