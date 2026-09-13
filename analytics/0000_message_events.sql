-- SAD 6.2's raw event table, with every divergence from the published DDL commented.
-- The document is amended to match (docs/05-sad.md, and the chapter says so).
CREATE TABLE IF NOT EXISTS relay_analytics.message_events (
    environment_id  UUID,
    channel_id      UUID,
    -- DIVERGENCE 1: SAD publishes UUID. `messages.user_id` is nullable -- a message whose
    -- author was deleted has none -- and a NULL inserted into a non-nullable UUID becomes
    -- the ZERO UUID without failing, inventing one active user per environment.
    -- Nullable makes uniqExact ignore it, exactly as count(DISTINCT user_id) does.
    user_id         Nullable(UUID),
    ts              DateTime64(3, 'UTC'),
    event           LowCardinality(String),   -- created|edited|deleted
    -- DIVERGENCE 2 and 3: both are Nullable because the value is sometimes NOT KNOWN, and
    -- 0 is a different claim. lengthUTF8(NULL) inserts 0 into a non-nullable column, and a
    -- text_length of 0 says a zero-length message was sent. A tombstone preserves no text
    -- and an unedited attachment-only message has none either.
    text_length     Nullable(UInt32),
    attachment_count Nullable(UInt8),
    -- DIVERGENCE 4: SAD publishes UInt32, and NOTHING PRODUCES THIS COLUMN until
    -- FR-ANL-10's chapter (FR-006a). Non-nullable, every row would read 0 ms -- a
    -- measured claim about a delivery nobody timed. An absent producer writes NULL.
    delivery_latency_ms Nullable(UInt32)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)                     -- DR-07
ORDER BY (environment_id, ts)                 -- tenant-scoped range scans
-- DIVERGENCE 5: SAD publishes `TTL ts + INTERVAL 90 DAY`, which this server refuses:
--   Code: 450. TTL expression result column should have DateTime or Date type,
--   but has DateTime64(3, 'UTC'). (BAD_TTL_EXPRESSION)
TTL toDateTime(ts) + INTERVAL 90 DAY          -- DR-09
