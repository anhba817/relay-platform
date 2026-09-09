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
  --
  -- WHICH ROW A BEFORE TRIGGER RETURNS DECIDES WHETHER THE WRITE HAPPENS, and
  -- getting it wrong here is worse than the fault this file exists to catch. A
  -- BEFORE UPDATE trigger returning OLD does not allow the update — it replaces it
  -- with a write of the old values, silently, with rowCount 1 and no error. So the
  -- exemption has to hand back NEW on an UPDATE and OLD on a DELETE, which is the
  -- only row each of them has.
  --
  -- The symptom is nowhere near the cause: an exempt sweep disables the same rows
  -- on every pass and never runs out, because every write it made was reverted by
  -- the trigger that claimed to permit it. `guard.itest.ts` asserts this by reading
  -- the value back, since a row count cannot tell the two apart.
  IF current_setting('relay.allow_global', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT owner INTO who FROM __sentinel_environments
   WHERE environment_id = OLD.environment_id;

  -- The message is a contract — see contracts/guard.md. Prefix, schema, table,
  -- row key, and the diagnosis. NO SUGGESTED FIX: the right scoped alternative
  -- depends on what the test meant, and a guess printed as advice is worse than
  -- silence. That guidance belongs in the lint rule, which knows the call site.
  --
  -- `to_jsonb(OLD) ->> 'id'` AND NOT `OLD.id`, BECAUSE NOT EVERY GUARDED TABLE HAS
  -- ONE. PL/pgSQL resolves `OLD.id` at RUNTIME against the row the trigger fired for,
  -- so a table with no `id` raises `record "old" has no field "id"` — from inside the
  -- refusal path, replacing the diagnosis with a message about the diagnosis.
  --
  -- Two tables carried an `id` when this was written and the third does not:
  -- `read_positions` is keyed `(channel_id, user_id)` because that is what a read
  -- position is. `to_jsonb` turns the row into a document first, so the lookup is a
  -- key that may be absent rather than a field that must exist, and the whole row is
  -- the fallback — which is more useful anyway for a table whose identity is a pair.
  RAISE EXCEPTION
    'global-operation guard: this statement modified sentinel row %.% (key %), which belongs to no test%',
    TG_TABLE_SCHEMA, TG_TABLE_NAME,
    COALESCE(to_jsonb(OLD) ->> 'id', to_jsonb(OLD)::text),
    COALESCE(' — the bait planted by ' || who, '');
END $$;

-- One trigger per table carrying environment_id, firing only for a sentinel's
-- rows. Not `outbox`: it has no environment_id because it is platform
-- bookkeeping, so its bait is protected by the reader mechanism only. A stated
-- gap rather than an oversight (data-model.md).
--
-- THIS ARRAY IS NOT A COUNT, AND THAT IS DELIBERATE. Every table that carries
-- `environment_id` joins it IN THE CHAPTER THAT CREATES THE TABLE, together with
-- the sentinel row that makes the trigger's WHEN clause match and the case in
-- `guard.itest.ts` that drives it. Naming a number here — "five tables", "nine
-- tables" — would be a fact about the chapter that wrote the number, and every
-- later chapter would have to remember to change it. Nothing checks a comment.
--
-- AND BEING IN THIS ARRAY IS NOT BEING WATCHED. The trigger fires only when
-- `__is_sentinel(OLD.environment_id)` is true, which needs a sentinel row sitting
-- in the table. A name added here without bait planted in `sentinel.ts` installs
-- a trigger that can never match, and it reads exactly like protection. So the
-- three go together: the name, the bait, and the case.
--
-- AND FOR A LONG TIME ONLY TWO OF THE THREE WERE CHECKED. `guard.itest.ts` compares
-- this array against its own `SHAPES` and against `pg_trigger`, both directions each
-- — and asserted nothing about the bait, because every case in it plants its own row.
-- Deleting an insert from `plant()` left that suite entirely green. The quota chapter
-- added the third assertion: `plant()` must leave a row in every table named here,
-- asked of the database rather than of `sentinel.ts`'s source.
--
-- `members` IS THE COUNTER-EXAMPLE AND BELONGS NOWHERE NEAR THIS LIST. It has no
-- `environment_id` — the catalogue classifies it `hop`, reaching the environment
-- through `channels` — so `OLD.environment_id` would not compile in the WHEN
-- clause. The rule is the column, not the intuition that a table "feels" tenant.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- The instruments chapter's two. Both carry `environment_id`, both hold bait
    -- planted by `sentinelFor`, and `guard.itest.ts` drives each one.
    'channels',
    'users',
    -- THIS CHAPTER'S, AND IT ARRIVES WITH THE TABLE. `read_positions` carries
    -- `environment_id` although `channel_id` already determines it, precisely so this
    -- trigger can exist — a table without the column is a table the guard cannot
    -- refuse a cross-environment delete on.
    --
    -- AND IT HAS NO `id`, which is the case the refusal message was changed for: it
    -- interpolates `coalesce(to_jsonb(OLD) ->> 'id', to_jsonb(OLD)::text)` rather than
    -- `OLD.id`, so a table keyed on `(channel_id, user_id)` still names the row it
    -- refused.
    --
    -- `members` REMAINS THE COUNTER-EXAMPLE. It is per-member state too and it is
    -- deliberately absent: no `environment_id`, so the catalogue calls it `hop` and
    -- `OLD.environment_id` would not compile in the WHEN clause above. The rule is the
    -- column, not the intuition that a table feels tenant-scoped.
    'read_positions',
    -- THE QUOTA CHAPTER'S THREE, AND ALL THREE ARRIVE WITH THE TABLES. Every one
    -- carries `environment_id` as its first primary-key column, which is the rule this
    -- array follows — the column, not the intuition.
    --
    -- THEY ARE THE FIRST GUARDED TABLES WHOSE ROWS ARE MONEY. A cross-environment
    -- DELETE on `channels` loses somebody's messages; one on `usage_periods` loses the
    -- count a customer is billed against, and the platform cannot tell afterwards
    -- whether the month was quiet or the row was dropped. `usage_active_users` is the
    -- same fact one dimension over, and `quota_notifications` is the record that a
    -- customer was warned — deleting it makes the platform willing to warn them twice
    -- or, if `delivered_at` was set, not at all.
    --
    -- TWO OF THEM HAVE NO `id`, which is the case `read_positions` above changed the
    -- refusal message for: `usage_periods` is keyed `(environment_id, period)` and
    -- `usage_active_users` on a triple. The message interpolates
    -- `coalesce(to_jsonb(OLD) ->> 'id', to_jsonb(OLD)::text)`, so both still name the
    -- row they refused. `quota_notifications` does have one, and it is listed beside
    -- them rather than apart, because the guard's rule has never been about the key.
    'usage_periods',
    'usage_active_users',
    'quota_notifications'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS __sentinel_guard_%1$s ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER __sentinel_guard_%1$s
         BEFORE UPDATE OR DELETE ON %1$I FOR EACH ROW
         WHEN (__is_sentinel(OLD.environment_id))
         EXECUTE FUNCTION __sentinel_guard()', t);
  END LOOP;
END $$;
