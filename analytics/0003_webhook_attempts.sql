-- One row per webhook delivery attempt, shaped by what the publisher already sends rather
-- than by a document: SAD 6.2 publishes `message_events` as *representative* and names
-- `emoji_events`, and no table for delivery attempts is published anywhere. The chapter
-- amends the SAD to publish this one.
CREATE TABLE IF NOT EXISTS relay_analytics.webhook_attempts (
    environment_id  UUID,
    ts              DateTime64(3, 'UTC'),
    delivery_id     UUID,
    endpoint_id     UUID,
    event_id        UUID,
    attempt         UInt8,
    -- NULLABLE BECAUSE THE VALUE IS SOMETIMES NOT KNOWN, AND 0 IS A DIFFERENT CLAIM.
    -- The publisher spreads these in only when present: "an explicit `undefined` is not
    -- the same as an absent key, and the difference is the whole meaning of 'nothing
    -- answered'." A non-nullable `status` would write 0 and assert that an endpoint
    -- answered with status zero. A timeout has no status; inventing one would make every
    -- dashboard built on this lie in the same direction.
    status          Nullable(UInt16),
    error           Nullable(String),
    -- How long the ENDPOINT took to answer. NOT `message_events.delivery_latency_ms`,
    -- which is how long a message took to reach a client and still has no producer.
    latency_ms      UInt32,
    outcome         LowCardinality(String),   -- delivered|rescheduled|dead_lettered
    -- THE ONLY THING BETWEEN A FIELD-NAME TYPO AND AN EMPTY TABLE.
    --
    -- The publisher's field is `attempted_at` and this column is `ts`. A JSONEachRow
    -- insert whose keys do not match column names leaves the column AT ITS DEFAULT with
    -- no error, and a DateTime64 default is the epoch -- which is older than the TTL
    -- below, so the row is deleted at insert. Measured: 0 rows, before and after a merge.
    -- The insert returns OK, the consumer acknowledges, the stream drains to zero, and
    -- every instrument in the chain reports success over an empty table.
    --
    -- `input_format_skip_unknown_fields = 0` on the insert catches a RENAMED field
    -- (Code: 117). It does not catch an ABSENT one -- a row with no `ts` at all takes the
    -- default without complaint. This does.
    CONSTRAINT ts_is_real CHECK ts > toDateTime64('2020-01-01 00:00:00', 3, 'UTC')
)
-- REPLACINGMERGETREE, AND THE SORTING KEY IS ALSO THE DEDUPLICATION KEY.
--
-- `(environment_id, ts)` is the tenant-then-time ordering chapter 4.2's argument is about;
-- `(delivery_id, attempt)` is what makes a record unique -- the same pair the publisher
-- already treats as identity. All four in the sorting key gets the range scans and the
-- deduplication from one declaration, and it is safe because `ts` comes from
-- `attempted_at`, a FIELD OF THE RECORD rather than the time it was consumed: the same
-- record sorts to the same place however it was batched.
--
-- `insert_deduplication_token` would have been cheaper -- the server refuses the duplicate
-- block at insert, with no read cost -- and it cannot be used. It needs a token stable
-- across a redelivery, and JetStream batch boundaries are not: a retry with a different
-- `max_messages` returned 4,5,1,2,3,6,7,8,9,10 where the original batch was 1,2,3,4,5.
-- Worse, the token keys on ITSELF and not the content: the same token with 500 completely
-- different rows dropped all 500 and reported success.
--
-- READS TAKE `FINAL`. The duplicate is physically present until a merge, so a bare
-- SELECT count() over-counts. That is 4.2's rollup lesson one engine over: there the read
-- contract became sum() with GROUP BY, here it is FINAL.
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)                            -- DR-07, as message_events
ORDER BY (environment_id, ts, delivery_id, attempt)
TTL toDateTime(ts) + INTERVAL 90 DAY                 -- DR-09, and toDateTime because the
                                                     -- published form is refused (Code: 450)
