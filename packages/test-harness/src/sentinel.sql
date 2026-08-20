-- The global-operation guard (feature 030).
--
-- WHY THIS IS PL/pgSQL, in a repository committed to one language. The guard has
-- to raise inside the transaction that performed the mutation: that is the
-- property which makes attribution exact under parallel test execution, and no
-- TypeScript running in the test process has it. A before/after comparison cannot
-- attribute — legitimate global sweeps run on every lane pass, so it either fires
-- constantly or blames a bystander — and it cannot see a raw UPDATE at all.
--
-- Constitution VII says "Introducing a second language requires a superseding ADR
-- with profiling evidence". There is no ADR, because there is nothing for one to
-- supersede: VII's clause reads "One language (TypeScript/Node.js) across
-- services, SDK, and dashboard", its subject is the language services are
-- implemented in, and its stated harm is drift between server and SDK. This is
-- neither a service nor shipped. The repository already holds nine hand-reviewed
-- .sql migrations the constitution endorses by name.
--
-- The honest wrinkle: those nine are DECLARATIVE and this one is PROCEDURAL. A
-- RAISE EXCEPTION is closer to program logic than an ALTER TABLE is. That
-- difference is real; it is not the difference VII legislates. The long form is in
-- docs/07-tutorial-plan.md, under "Work that publishes no chapter".
--
-- THIS FILE IS NEVER A MIGRATION. It is applied by the lane's global setup against
-- a test database. A product migration carrying it would ship a trigger whose only
-- purpose is to reject the api's own legitimate sweeps (constitution IV).

-- The registry the per-file sentinel needs. With one shared sentinel the trigger
-- could compare against a literal id; with one per test file it tests membership.
-- `owner` is the file path, and it is what lets a refusal say whose rows were taken.
CREATE TABLE IF NOT EXISTS __sentinel_environments (
  environment_id uuid PRIMARY KEY,
  owner          text NOT NULL
);

-- Membership as a FUNCTION, not a subquery. A trigger's WHEN condition may not
-- contain a subquery — Postgres rejects `CREATE TRIGGER` outright with "cannot use
-- subquery in trigger WHEN condition" — but it may call a function. STABLE so the
-- planner can cache it within a statement, which matters because this runs for
-- every UPDATE and DELETE on five tables across the whole lane (research R37).
CREATE OR REPLACE FUNCTION __is_sentinel(env uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM __sentinel_environments WHERE environment_id = env)
$$;

CREATE OR REPLACE FUNCTION __sentinel_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  who text;
BEGIN
  -- Refusal is the default: current_setting(..., true) returns NULL in a
  -- connection that never carried the option, and NULL is not 'on'.
  IF current_setting('relay.allow_global', true) = 'on' THEN
    RETURN OLD;
  END IF;

  SELECT owner INTO who FROM __sentinel_environments
   WHERE environment_id = OLD.environment_id;

  -- The message is a contract — see contracts/guard.md. Prefix, schema, table,
  -- row id, and the diagnosis. NO SUGGESTED FIX: the right scoped alternative
  -- depends on what the test meant, and a guess printed as advice is worse than
  -- silence. That guidance belongs in the lint rule, which knows the call site.
  RAISE EXCEPTION
    'global-operation guard: this statement modified sentinel row %.% (id %), which belongs to no test%',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id,
    COALESCE(' — the bait planted by ' || who, '');
END $$;

-- One trigger per table carrying environment_id, firing only for a sentinel's
-- rows. Not `outbox`: it has no environment_id because it is platform
-- bookkeeping, so its bait is protected by the reader mechanism only. A stated
-- gap rather than an oversight (data-model.md).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'webhook_endpoints',
    'webhook_deliveries',
    'webhook_disable_notifications',
    'channels',
    'users'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS __sentinel_guard_%1$s ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER __sentinel_guard_%1$s
         BEFORE UPDATE OR DELETE ON %1$I FOR EACH ROW
         WHEN (__is_sentinel(OLD.environment_id))
         EXECUTE FUNCTION __sentinel_guard()', t);
  END LOOP;
END $$;
