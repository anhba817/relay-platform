-- THE BILLING ROLLUP, AND IT EXISTS BECAUSE A MEASUREMENT KILLED THE ONE-TABLE DESIGN.
--
-- `daily_usage_v2` is keyed (environment_id, channel_id, day) because FR-ANL-09 names four
-- attribution dimensions and `message_events` carries `channel_id` on the row -- so channel
-- looked like a key column rather than a join, and a second table looked like premature
-- structure. Measured against a 248,155-row corpus over 91 days and 2,400 channels:
--
--   daily_usage_v2, distinct (environment_id, channel_id, day)   147,534
--   the same rows, distinct (environment_id, day)                    286
--   4.2's daily_usage, keyed (environment_id, day)                   276
--
-- The table is fully merged -- every row is a distinct key, and `OPTIMIZE FINAL` changes
-- nothing. **Channel multiplied the rollup by 515.**
--
-- AND THAT COSTS DR-10 THE PROPERTY IT IS ABOUT. One tenant's 91-day bill, read from the
-- server's own accounting:
--
--   rollup read   32,778 rows · 3.56 MiB · 4 ms
--   raw table     32,768 rows · 1.31 MiB · 3 ms
--
-- "Billing never scans raw events" was true in the letter and worth nothing: the billing
-- read touched MORE rows than the raw table it was supposed to replace, because a tenant-day
-- total has to sum across that tenant's channels. 4.2 published 315 rows against 1,052,655;
-- this is the same clause measured on a key one dimension wider.
--
-- SO THERE ARE TWO ROLLUPS, WHICH IS THE ORDINARY ANSWER AND THE NUMBERS ARGUE FOR IT.
-- This one is keyed (environment_id, day) and is what billing reads. `daily_usage_v2` keeps
-- the channel key and answers FR-ANL-09's attribution question. Neither is a compromise of
-- the other, and one table could not have been both.
CREATE TABLE IF NOT EXISTS relay_analytics.daily_usage_billing
(
    environment_id  UUID,
    day             Date,
    messages        UInt64,
    active_users_state AggregateFunction(uniq, Nullable(UUID)),
    stored_delta    Int64,
    connection_minutes UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (environment_id, day)
-- No TTL, for FR-003a's reason: metering must not lose history when raw events expire.
-- AND THIS ONE DOES NOT WIDEN 048-4. Its key is (environment_id, day), the same product
-- 048-4 already names -- the channel-keyed table is where that item grew.
