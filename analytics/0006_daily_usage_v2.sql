-- FR-ANL-05's four quantities, per tenant per day, in ONE ROW.
--
-- A TABLE, NOT A VIEW WITH AN INLINE ENGINE, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.
-- Chapter 4.2's `daily_usage` was written as `CREATE MATERIALIZED VIEW ... ENGINE = ...`,
-- which gives it an IMPLICIT inner table (`.inner_id.<uuid>`) and no name a second view can
-- write into. A materialised view fires on inserts to exactly ONE source table, and this
-- chapter's four quantities come from two -- messages and active users from
-- `message_events`, connection-minutes from `connection_events` -- so a single view cannot
-- carry them.
--
-- Measured before anything was written (research R1): two views over two different sources,
-- both `TO` this table, each naming only its own columns. The columns a view omits arrive at
-- their type's zero and `SummingMergeTree` adds them, so one tenant-day ends up as one row.
-- The probe that first "proved" this had both views writing the SAME column and therefore
-- proved nothing about the shape that ships; the re-run is in `baseline.txt`.
CREATE TABLE IF NOT EXISTS relay_analytics.daily_usage_v2
(
    environment_id  UUID,
    -- FR-ANL-09 names four attribution dimensions -- application, environment, channel, day
    -- -- and `message_events` carries `channel_id` on the row, so channel costs a key column
    -- rather than a join. APPLICATION IS ON NO ROW IN THIS STORE and its mapping lives in
    -- Postgres, so it stays an open item rather than becoming a cross-path read.
    --
    -- A CONNECTION BELONGS TO A TENANT AND NOT TO A CHANNEL, so rows from the connection
    -- view carry the zero UUID here. That is a value a reader will meet in the first query
    -- they write, which is why it is documented rather than discovered.
    channel_id      UUID,
    day             Date,
    messages        UInt64,
    -- AN AGGREGATE STATE, NOT A NUMBER. Written with `uniqState`, read with `uniqMerge`.
    -- `Nullable(UUID)` because 046 measured a NULL `user_id` inserted into a non-nullable
    -- column becoming the ZERO UUID silently -- one phantom active user per environment,
    -- holding a deleted author's messages. 047 then measured `uniqState`/`uniqMerge`
    -- ignoring NULL exactly as `uniqExact` does, so the fix survives into the rollup.
    --
    -- `uniq` IS APPROXIMATE: exact to roughly 60,000-65,000 distinct and off by 0.51% at
    -- 70,000. Any figure published from this column states the corpus cardinality beside it,
    -- and 047-1 is the record of why that matters against FR-ANL-06's 0.1% bound.
    active_users_state AggregateFunction(uniq, Nullable(UUID)),
    -- Int64, NOT UInt64, and it is a DELTA rather than a balance.
    --
    -- The stored message count is the only quantity here that is a stock: every other one is
    -- a daily flow. So the column holds the day's change -- +1 created, -1 deleted -- and the
    -- stored count is the cumulative sum up to and including a day. DR-17 states the
    -- technique for the media analogue in as many words: "summing `media_events` deltas
    -- (uploaded/deleted)".
    --
    -- UNSIGNED WOULD WRAP on any day whose deletions exceed its creations, which is any day
    -- a tenant clears a backlog. Measured signed: 2 created, 1 deleted, 1 edited -> 1.
    stored_delta    Int64,
    connection_minutes UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (environment_id, channel_id, day)
-- NO TTL, AND THAT IS DELIBERATE -- the same reasoning FR-003a records for `daily_usage`.
-- `message_events` expires at 90 days (DR-09) and metering must not lose history when raw
-- events do.
--
-- IT ALSO WIDENS AN OPEN ITEM. 048-4 carries "the rollup is still unbounded ... no clause
-- says how long metering history is kept", against a key of (environment_id, day). This key
-- adds `channel_id`, so the product becomes environments x channels x days. The item is
-- re-measured in this feature's gaps.md rather than carried forward as a sentence.
