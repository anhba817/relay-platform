-- The ledger. `CREATE ... IF NOT EXISTS` is idempotent and reports nothing; this table is
-- how a run can say what it DID, which is the half that makes a zero mean something.
--
-- APPLIED BEFORE 0000 BY THE SCRIPT'S OWN BOOTSTRAP, not in filename order: a ledger
-- cannot record its own creation from a table that does not exist. And one step above
-- that, apply.mjs issues CREATE DATABASE IF NOT EXISTS first -- a ledger cannot live in a
-- database that does not exist either, and CLICKHOUSE_DB does not reliably create one.
CREATE TABLE IF NOT EXISTS relay_analytics.schema_applied (
    filename    String,
    applied_at  DateTime64(3, 'UTC') DEFAULT now64(3),
    checksum    String
)
ENGINE = MergeTree
ORDER BY filename
