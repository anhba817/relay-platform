-- FR-002. The one FR-ANL-05 quantity this chapter can populate from live traffic.
--
-- CLOSE ROWS ONLY, AND THE OPEN ROW ADDS NOTHING. Measured: a close carries the closing
-- instant in `ts` and the elapsed duration in `duration_ms`, so `ts - duration_ms` recovers
-- the open. Verified against three real rows -- 02:58:03.876 minus 252 ms gives 02:58:03.624.
--
-- WHICH ALSO MEANS 44% OF THE CONNECTIONS IN THIS STORE CONTRIBUTE NOTHING. 55 of 99 have
-- both records; 44 have only an open. Chapter 4.5 measured why: `sessions.close()` calls
-- `wss.close()`, which does not close established sockets, so a clean stop produces opens
-- with no closes and a kill produces neither. Those connections are not billed a wrong
-- number -- they are billed zero, and the count of them is published beside the figure
-- rather than folded into it (050-5).
--
-- THE CALENDAR-MINUTE DEFINITION, NOT THE ELAPSED ONE, AND PHASE 6 IS WHERE THAT WAS
-- DECIDED. Both are computable here: elapsed is `sum(duration_ms)` and this is the other.
-- SRS Appendix C open question 4 -- "does connection-minute metering need per-second
-- precision, or is per-minute rounding acceptable?" -- has been open since before Part 4
-- and names FR-ANL-05. It is answered in `docs/04-srs.md` and in this feature's
-- `baseline.txt`; a chapter that puts a number in a billing table cannot leave its unit
-- undefined.
--
-- The expansion charges every calendar minute a connection was open for any part of, which
-- is `meter.ts`'s documented rule: "Open at 00:00:59 and closed at 00:01:01 is two seconds
-- of wall clock and TWO connection-minutes." Measured here at 2 for exactly that case. It
-- charges reconnect churn, which summing seconds does not.
--
-- A CONNECTION SPANNING MIDNIGHT NEEDS NO SPECIAL HANDLING: each minute gets its own
-- `toDate`, so the row splits across two days on its own.
--
-- `channel_id` IS NOT WRITTEN. A connection belongs to a tenant, not to a channel, so these
-- rows carry the zero UUID in that column -- documented in `0006` and in the contract,
-- because it is the first thing a reader meets when they group by channel.
CREATE MATERIALIZED VIEW IF NOT EXISTS relay_analytics.mv_daily_usage_connection_minutes
TO relay_analytics.daily_usage_v2
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
