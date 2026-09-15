-- DR-09's 25 months on the channel-keyed rollup. Its own file because `apply.mjs` refuses a
-- file holding two statements, and the ledger is keyed on filename.
--
-- THIS IS THE TABLE 048-4's GROWTH CONCERN IS ACTUALLY ABOUT. Its key gained `channel_id`,
-- so it grows at `environments x channels x days` -- measured at 147,534 rows where the
-- (environment_id, day) shape had 281, over one 91-day corpus. A bound of 25 months on that
-- product is the difference between a table that is large and one that is unbounded.
ALTER TABLE relay_analytics.daily_usage_v2
    MODIFY TTL toDateTime(day) + INTERVAL 25 MONTH
