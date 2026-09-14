-- FR-ANL-07's retention half: a queryable API request log per tenant for 30 days.
--
-- A SECOND TABLE RATHER THAN COLUMNS ON `webhook_attempts`, and the reason is the retention.
-- FR-ANL-07 says 30 days; the attempt table says 90. One `TTL` clause cannot express both,
-- and the column sets overlap only on `environment_id`, `ts` and `latency_ms`.
--
-- `environment_id` IS NULLABLE, WHICH IS THE ONE DECISION HERE WORTH ARGUING. FR-ANL-01 wants
-- a record for every API request and a large share of them resolve to no tenant: every 404,
-- every 401, /healthz, signup, and -- the volume case -- every call the dispatcher and gateway
-- make on the internal seam, whose `platform` principal carries no `environmentId` BY DESIGN.
-- Constitution I says every analytical record must carry a non-null tenant; it governs tenant
-- DATA, and a record with no tenant is reachable by no tenant-scoped filter. Measured: over a
-- table holding both, tenant A's filter returns its own row and tenant B's returns 0.
--
-- NO SENTINEL. Not the zero UUID -- 047 measured that producing one phantom active user per
-- environment, holding a deleted author's messages -- and not an empty string. A value meaning
-- "unknown" inside the tenant column is the failure this whole argument exists to avoid.
CREATE TABLE IF NOT EXISTS relay_analytics.api_requests (
    environment_id Nullable(UUID),
    ts             DateTime64(3, 'UTC'),
    request_id     UUID,
    -- ABSENT AND EMPTY ARE DIFFERENT FACTS, AND `LowCardinality(String)` CANNOT HOLD THE
    -- DIFFERENCE. Measured through JSONEachRow: an absent field and an explicit "" both land
    -- as ''. A 404 has no endpoint and a middleware refusal has no endpoint YET -- the router
    -- had not run -- and neither is a route named the empty string. This is 048's defect
    -- (a field the publisher omits takes a column default silently) on a different column,
    -- and none of 048's three guards reaches it: the skip-unknown-fields setting catches an
    -- UNKNOWN field, not an absent one, and a CHECK cannot help because absent is legal here.
    endpoint       LowCardinality(Nullable(String)),
    method         LowCardinality(String),
    status         UInt16,
    latency_ms     UInt32,
    -- `application` | `user` | `platform` | `none`. The column that makes the chapter's
    -- central number answerable from the table: how many records have no tenant, and why not.
    -- `platform` and `none` are different facts and collapsing them loses the argument.
    principal_kind LowCardinality(String),
    -- WHICH LAYER DECIDED THE RESPONSE: `handler` | `guard` | `middleware` | `unmatched`.
    -- Two of those are stamped by the layer that refuses and two are inferred, because a
    -- guard refusal and a handler response are identical from the producer's vantage point --
    -- same status, same req.route, same request properties.
    refused_at     LowCardinality(String),
    -- `send` | `rest` | `signup`, when the rate limiter refused. NOT a route template: the
    -- limiter's whole route knowledge is three-valued, so a per-endpoint breakdown of its
    -- refusals would describe a mechanism that does not exist.
    limited_operation LowCardinality(Nullable(String)),
    -- 048 measured that an unmatched column takes its DEFAULT with no error, that a
    -- DateTime64 default is the epoch, and that the epoch is older than any TTL -- so the row
    -- is deleted at insert while the insert returns OK and the stream drains to zero.
    CONSTRAINT ts_is_real CHECK ts > toDateTime64('2020-01-01 00:00:00', 3, 'UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
-- `request_id` last, so deduplication is on the RECORD'S OWN KEY. 048 measured that a token
-- derived from a batch is not stable across a redelivery: a retry at a different max_messages
-- returned 4,5,1,2,3,6,7,8,9,10 where the original batch was 1,2,3,4,5.
ORDER BY (environment_id, ts, request_id)
-- `toDateTime(ts)`, not `ts` -- 047 measured `TTL ts + INTERVAL` on a DateTime64 refused with
-- BAD_TTL_EXPRESSION, after the SAD had published the broken form since its first draft.
TTL toDateTime(ts) + INTERVAL 30 DAY
-- Without this, ClickHouse 25.3 refuses the whole statement:
--   Code: 44. Sorting key contains nullable columns, but merge tree setting
--   `allow_nullable_key` is disabled. (ILLEGAL_COLUMN)
SETTINGS allow_nullable_key = 1
