-- FR-ANL-01's LAST ARM WITHOUT A PRODUCER: connection open and close.
--
-- A FOURTH TABLE, for the reason there is a third. `webhook_attempts` keeps 90 days and
-- `api_requests` keeps 30 because FR-ANL-07 says so; one TTL clause cannot express two
-- retentions, and one table cannot hold three column sets that overlap only on
-- `environment_id` and `ts`.
--
-- `environment_id` IS NOT NULLABLE HERE, UNLIKE `api_requests`, and the difference between
-- the two chapters is worth stating rather than inheriting. A request can be made by
-- nobody: every 404, every 401, /healthz, and every call the dispatcher and gateway make on
-- the internal seam, whose `platform` principal carries no environment by design. A
-- CONNECTION cannot. `open()` is the only function that builds one and the only caller of
-- `registry.add`; it takes a non-optional `Identity`, and its single call site is reached
-- only after the 429 upgrade refusal, 4001, 1011, 4003, 4008 and the 4004 connection cap
-- have each returned. An unauthenticated SOCKET exists; an unauthenticated CONNECTION does
-- not. So there is no tenantless record to carry, no `_none` arm, and no
-- `allow_nullable_key` setting either -- every column in the sorting key is non-nullable.
CREATE TABLE IF NOT EXISTS relay_analytics.connection_events (
    environment_id UUID,
    ts             DateTime64(3, 'UTC'),
    connection_id  UUID,
    -- `opened` | `closed`.
    event          LowCardinality(String),
    -- ONLY ON A CLOSE, AND A NUMBER RATHER THAN A STRING. A close code is a small integer,
    -- and a String column answers `WHERE close_code = 1000` with nothing and no error.
    -- Measured: ClickHouse coerces a JSON number into a String column AND a JSON string
    -- into a UInt16, so a type disagreement between producer and table lands silently in
    -- whichever spelling the producer happened to send -- there is no loud direction.
    --
    -- AND IT IS NOT DRAWN FROM `CLOSE_CODES`. That registry holds 4001, 4002, 4003, 4004,
    -- 4008 and 4009 -- the platform's own 4xxx range. A clean close is 1000 and an abnormal
    -- one is 1006, and neither is in it, so `check:errors` does not guard this column's
    -- vocabulary. What survives is the narrower claim: an integer the protocol defines,
    -- not a sentence somebody writes.
    close_code     Nullable(UInt16),
    -- UInt64, NOT UInt32. Nothing caps a socket's lifetime -- the only lifetime control is
    -- `MAX_MISSED_PINGS` on a 30-second ping, which ends a socket that has stopped
    -- answering rather than one that has not -- and UInt32 milliseconds wraps at 49.7 days.
    -- The cost is four bytes on a column that is null on every open record.
    duration_ms    Nullable(UInt64),
    -- NOT nullable. It comes from the same `Identity` as `environment_id`, and both fields
    -- are declared `string` rather than `string | undefined`, so a connection event has
    -- both or neither. (That `Identity` has a THIRD field, `token`, is why the producer
    -- names every field rather than spreading: constitution III's allow-list -- "only
    -- lengths, identifiers, and metadata" -- refuses a credential by construction.)
    user_external_id String,
    -- 048 measured that an unmatched column takes its DEFAULT with no error, that a
    -- DateTime64 default is the epoch, and that the epoch is older than any TTL -- so the
    -- row is deleted at insert while the insert returns OK and the stream drains to zero.
    -- `input_format_skip_unknown_fields=0` catches a RENAMED field and cannot catch an
    -- absent one. This can.
    CONSTRAINT ts_is_real CHECK ts > toDateTime64('2020-01-01 00:00:00', 3, 'UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)                                  -- DR-07
-- `event` LAST, AND IT IS THE ONE DECISION IN THIS FILE THAT CANNOT BE GUESSED. One
-- connection produces TWO rows under one `connection_id`; without `event` in the key a
-- ReplacingMergeTree collapses the open into the close and a reader sees half the story.
-- Verified against the server: `count() FINAL` is 2, not 1. That is 4.3's lesson applied
-- rather than re-learned -- idempotence is the record's own key, and this record's own key
-- includes which event it is.
ORDER BY (environment_id, ts, connection_id, event)
-- `toDateTime(ts)`, not `ts` -- 047 measured `TTL ts + INTERVAL` on a DateTime64 refused
-- with BAD_TTL_EXPRESSION, after the SAD had published the broken form since its first
-- draft.
--
-- AND 90 IS A DEFAULT RATHER THAN A DERIVATION. FR-ANL-07 fixes 30 for the request log and
-- nothing fixes this one; FR-ANL-05's metering window is the calendar month, so 90 matches
-- `webhook_attempts` and DR-09's raw-event retention. Said out loud because a number nobody
-- argued for reads like one somebody did.
TTL toDateTime(ts) + INTERVAL 90 DAY
