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
  allowed text;
BEGIN
  -- Refusal is the default: current_setting(..., true) returns NULL in a
  -- connection that never carried the option, and NULL is not 'on'.
  --
  -- WHICH ROW A BEFORE TRIGGER RETURNS DECIDES WHETHER THE WRITE HAPPENS, and
  -- getting it wrong here is worse than the fault this file exists to catch. A
  -- BEFORE UPDATE trigger returning OLD does not allow the update — it replaces
  -- it with a write of the old values, silently. Measured: with `RETURN OLD` on
  -- both paths, an exempt suite swept 17 sentinel endpoints, sweeps them again
  -- on the next pass, and never runs out, because every disable was reverted by
  -- the trigger that claimed to permit it. The exemption has to hand back NEW on
  -- an UPDATE and OLD on a DELETE, which is the only row each has.
  --
  -- THE EXEMPTION NAMES TABLES, NOT FILES. `notifications.itest.ts` drives the
  -- notification relay, which is global over webhook_disable_notifications and
  -- nothing else; a file-wide pass let the same file sweep webhook_endpoints, and
  -- sweeping webhook_endpoints from there is instance 6 (research R41). `all` is
  -- for the planting connection, which deletes across every guarded table by
  -- definition.
  allowed := current_setting('relay.allow_global', true);
  IF allowed = 'all'
     OR (allowed IS NOT NULL
         AND TG_TABLE_NAME = ANY (string_to_array(allowed, ','))) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT owner INTO who FROM __sentinel_environments
   WHERE environment_id = OLD.environment_id;

  -- The message is a contract — see contracts/guard.md. Prefix, schema, table,
  -- row id, and the diagnosis. NO SUGGESTED FIX: the right scoped alternative
  -- depends on what the test meant, and a guess printed as advice is worse than
  -- silence. That guidance belongs in the lint rule, which knows the call site.
  --
  -- `OLD.id` UNTIL CHAPTER 3.12, and that is why extending the array below was
  -- not a one-line change. Three of the four usage tables have composite primary
  -- keys and no `id` column at all — `usage_periods` is
  -- `(environment_id, period)`, `usage_active_users` adds `user_id`,
  -- `usage_connections` is `(connection_id, period)` — and `OLD.id` on a record
  -- without that field raises `record "old" has no field "id"` AT EXECUTION TIME.
  -- A guard that fails on the writes it permits is worse than one that watches
  -- nothing, because it fails in the tests that were right.
  --
  -- The fallback PRINTS THE WHOLE ROW, and that is a deliberate bound rather than
  -- a convenience. These four carry counters, period dates and identifiers: no
  -- message text, no display names, no credentials. The same fallback on
  -- `messages` would put a customer's message body in a test log, which is an
  -- NFR-SEC-06 violation — so if this ever guards a table holding content, the
  -- expression has to name that table's key instead of dumping it.
  RAISE EXCEPTION
    'global-operation guard: this statement modified sentinel row %.% (id %), which belongs to no test%',
    TG_TABLE_SCHEMA, TG_TABLE_NAME,
    coalesce(to_jsonb(OLD) ->> 'id', to_jsonb(OLD)::text),
    COALESCE(' — the bait planted by ' || who, '');
END $$;

-- One trigger per table carrying environment_id, firing only for a sentinel's
-- rows. Not `outbox`: it has no environment_id because it is platform
-- bookkeeping, so its bait is protected by the reader mechanism only. A stated
-- gap rather than an oversight (data-model.md).
--
-- NINE, NOT FIVE, AS OF CHAPTER 3.12 (FR-036). The four usage tables were added
-- by chapters 3.10 and 3.11 and neither added them here, so a cross-environment
-- UPDATE or DELETE on any of them passed for two chapters. Confirmed against a
-- running database rather than read off this file: `pg_trigger` held five
-- `__sentinel_guard_*` rows and none of them was a usage table.
--
-- TEN AS OF CHAPTER 3.16. `read_positions` carries `environment_id`, so it belongs
-- here, and it has no `id` — which is what the message expression above was changed
-- for. `members` is the counter-example and is deliberately absent: it has no
-- `environment_id`, so the catalogue classifies it as `hop` and no trigger watches
-- it. Adding a table to this array is not the same as the guard watching it, which
-- is why `guard.itest.ts` drives each one and why removing a name from here has to
-- turn a test red.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'webhook_endpoints',
    'webhook_deliveries',
    'webhook_disable_notifications',
    'channels',
    'users',
    -- Chapters 3.10 and 3.11's tables. Every one carries `environment_id`, which
    -- is the only thing the WHEN clause below needs; what they do NOT all carry
    -- is `id`, which is what the message expression above had to change for.
    'usage_periods',
    'usage_active_users',
    'quota_notifications',
    'usage_connections',
    -- Chapter 3.16's table. Per-user read positions, keyed
    -- `(channel_id, user_id)` with no `id` column.
    'read_positions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS __sentinel_guard_%1$s ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER __sentinel_guard_%1$s
         BEFORE UPDATE OR DELETE ON %1$I FOR EACH ROW
         WHEN (__is_sentinel(OLD.environment_id))
         EXECUTE FUNCTION __sentinel_guard()', t);
  END LOOP;
END $$;
