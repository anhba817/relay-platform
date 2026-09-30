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
-- `sumMapIf(…, event = 'reserved')` COUNTS UPLOADS BY KIND AND `sum(bytes_delta)` SUMS THE
-- LEVEL'S DELTAS. A rendition is not an upload — nobody uploaded it — so only `reserved`
-- counts toward FR-009, while every event's bytes count toward the level. FR-010 is the
-- requirement that those two answers stay different on purpose and identical everywhere.
--
-- **THE `-If` COMBINATOR RATHER THAN A ZERO INSIDE THE MAP, AND A TEST IS WHAT CHANGED IT.**
-- The first version was `sumMap(map(kind, toUInt64(if(event = 'reserved', 1, 0))))`, which
-- gives every event's kind a key and non-uploads a value of `0`. Measured: a day holding one
-- image reservation, one audio REJECTION and one image rendition answered
-- `{'audio':0,'image':1}` — an `audio` key in a column called `uploads_by_kind`, for a day on
-- which nobody uploaded any audio. Worse for the caller than it looks: the key set stops
-- meaning *"the kinds this tenant uploaded"* and starts meaning *"the kinds that had any
-- media event"*, and a reader iterating the map reports a kind that belongs to a different
-- question.
--
-- `sumMapIf` emits no key for a row that does not match, and `{}` when no row in the group
-- does — which is `dailyUsage`'s own rule one level down: *"a day with no activity is a
-- missing row, never a row of zeros."* Measured before this line was written, both halves.
--
-- AND THE ZEROS WERE NOT SELF-CORRECTING. `SummingMergeTree` drops a row whose summed
-- columns are all zero; it does **not** drop a zero-valued key inside a map. Asked of the
-- server with `OPTIMIZE … FINAL`: `{'audio':0,'image':1,'video':0}` before the merge and
-- after it, unchanged. So the wrong answer was stable, which is the kind that survives.
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
    sumMapIf(map(kind, toUInt64(1)), event = 'reserved')    AS uploads_by_kind
FROM relay_analytics.media_events
GROUP BY environment_id, day
