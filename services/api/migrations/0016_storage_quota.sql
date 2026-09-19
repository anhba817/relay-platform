-- ---------------------------------------------------------------------------
-- The fourth quota dimension: stored bytes (chapter 4.10, FR-MED-02, FR-RTL-05).
-- ---------------------------------------------------------------------------
--
-- A DIMENSION THAT IS NOT A MONTHLY FLOW, WHICH IS WHY NOTHING IS ADDED TO
-- `usage_periods` HERE. The other three are flows: that table is keyed on a
-- calendar month and `creditFor` accumulates within one, never subtracting --
-- its own comment says *"the one thing this function must never do is subtract
-- from a bill"*. Stored bytes are a LEVEL. The figure falls when objects are
-- deleted and it does not reset on the 1st, so a `usage_periods` column would
-- have to subtract on delete and would hand a tenant holding 100 GB a fresh
-- 100 GB every month.
--
-- So the CAP is configuration and joins `quota_config` below; the ACCOUNTING is
-- `sum(declared_bytes)` over `media_objects`, which 0015 created. SRS FR-RTL-05
-- is amended in the same feature to say which of the four kinds it means, because
-- FR-MED-02 and FR-MED-12 both cite it for a quantity it did not define.
--
-- ---------------------------------------------------------------------------
-- DROPPED AND REBUILT WHOLE, NOT APPENDED TO.
-- ---------------------------------------------------------------------------
--
-- There is no `ALTER CONSTRAINT` for a CHECK expression, so 0014 dropped and
-- restated every dimension and this does the same with four. **A restatement
-- that omits one silently stops constraining it**, which is the same silent loss
-- `config.ts` warns about from the parser's side: the constraint would accept a
-- config the parser rejects, `capsFor` fails closed, and the cap would quietly
-- become no cap. The two have to move together, which is why the schema change
-- and the parser change are one feature and one commit.
--
-- Three clauses per dimension, the shape 0014 counted: one that the value is an
-- object, and one each for `hard` and `soft` being a non-negative integer
-- written as digits. Twelve clauses now, where 0013 had six.

ALTER TABLE environments
  DROP CONSTRAINT environments_quota_config_shape;

ALTER TABLE environments
  ADD CONSTRAINT environments_quota_config_shape CHECK (
    jsonb_typeof(quota_config) = 'object'
    AND (quota_config -> 'messages' IS NULL
         OR jsonb_typeof(quota_config -> 'messages') = 'object')
    AND (quota_config -> 'active_users' IS NULL
         OR jsonb_typeof(quota_config -> 'active_users') = 'object')
    AND (quota_config -> 'connection_minutes' IS NULL
         OR jsonb_typeof(quota_config -> 'connection_minutes') = 'object')
    AND (quota_config -> 'storage_bytes' IS NULL
         OR jsonb_typeof(quota_config -> 'storage_bytes') = 'object')
    AND (quota_config #>> '{messages,hard}' IS NULL
         OR quota_config #>> '{messages,hard}' ~ '^[0-9]+$')
    AND (quota_config #>> '{messages,soft}' IS NULL
         OR quota_config #>> '{messages,soft}' ~ '^[0-9]+$')
    AND (quota_config #>> '{active_users,hard}' IS NULL
         OR quota_config #>> '{active_users,hard}' ~ '^[0-9]+$')
    AND (quota_config #>> '{active_users,soft}' IS NULL
         OR quota_config #>> '{active_users,soft}' ~ '^[0-9]+$')
    AND (quota_config #>> '{connection_minutes,hard}' IS NULL
         OR quota_config #>> '{connection_minutes,hard}' ~ '^[0-9]+$')
    AND (quota_config #>> '{connection_minutes,soft}' IS NULL
         OR quota_config #>> '{connection_minutes,soft}' ~ '^[0-9]+$')
    AND (quota_config #>> '{storage_bytes,hard}' IS NULL
         OR quota_config #>> '{storage_bytes,hard}' ~ '^[0-9]+$')
    AND (quota_config #>> '{storage_bytes,soft}' IS NULL
         OR quota_config #>> '{storage_bytes,soft}' ~ '^[0-9]+$')
  );
