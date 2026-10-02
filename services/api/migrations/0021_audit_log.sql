-- Chapter 4.18 — FR-MOD-03's audit log, and the word in it that needed a mechanism.
--
-- "Every moderation action shall be recorded in an immutable audit log with actor,
-- action, target, timestamp, and request ID, retained for 1 year." Four of those five
-- fields are ordinary columns. `immutable` is the clause, and nothing in this schema had
-- ever had to mean it.
--
-- WHAT THE PLATFORM HAD INSTEAD, before this file:
--
--   messages.metadata.deleted_by   the actor's KIND and not which credential, on a
--                                  mutable column of the row being moderated, carrying no
--                                  request id — and published on no read path, so the one
--                                  fragment recorded about a moderation action is
--                                  invisible to the tenant whose log it would be
--   the request log (chapter 4.8)  3 of the 5 fields, a ReplacingMergeTree, TTL 30 days,
--                                  against "immutable" and "1 year"

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,

  -- CONSTITUTION I. Plain `REFERENCES`, which is this schema's convention for a tenant
  -- key and is also the right answer here for a reason worth stating: with no `ON DELETE`
  -- Postgres defaults to NO ACTION, so an environment holding moderation history cannot be
  -- deleted out from under it. Every other tenant foreign key in `schema.ts` is written
  -- this way; the single `ON DELETE CASCADE` in the file is `media_objects`' own
  -- parent/child key, and nothing in `services/api` deletes an environment at all.
  environment_id uuid NOT NULL REFERENCES environments(id),

  -- MILLISECOND, AND NOT THE DEFAULT MICROSECOND. This is the first keyset cursor over a
  -- timestamp column in Postgres in this platform, and it is the reason the precision is
  -- declared. `now()::timestamptz` is `…083489+00`; `toIso` is `value.toISOString()` and
  -- emits `…083Z`. A cursor minted from the transmitted value and compared against a
  -- column more precise than it loses the trailing microseconds, and in DESC order every
  -- row between `.083000` and `.083489` is skipped at the page boundary. The tiebreaker
  -- below does not save it — the pair's first element is already wrong.
  --
  -- UNFIXABLE LATER. Changing a column's precision rewrites every row.
  --
  -- The constitution says it in as many words — "All timestamps are stored and transmitted
  -- in UTC, RFC 3339, millisecond precision" — while all 40 existing `timestamptz` columns
  -- are precision 6. That platform-wide deviation is not this chapter's to repair; this
  -- column is `(3)` because it is the one place the deviation costs a reader rows.
  --
  -- AND IT IS `occurred_at`, NOT `created_at`. The two instants are identical by
  -- construction, because the row is written inside the action's transaction — which is
  -- exactly why the familiar name would mislead. A reader who sees `created_at` reasonably
  -- wonders whether the row could have been written later than the action. It cannot. If a
  -- later chapter ever writes an entry outside the action's transaction, this name is what
  -- will have to change, and that is the right place for the friction.
  occurred_at timestamptz(3) NOT NULL,

  actor_kind text NOT NULL,
  -- NULL FOR A PLATFORM PRINCIPAL, which carries no tenant and therefore no identifier a
  -- tenant could read. The key id for an application credential, the external id for a
  -- user.
  actor_id text,

  -- `METHOD /path`, the derived route's own key — `POST /v1/users/:externalId/ban` — and
  -- not a verb invented for the log. One name for the column, the read route's filter and
  -- the both-directions check in `src/audit/moderation-routes.ts`, so the check is a set
  -- comparison rather than a mapping somebody maintains.
  action text NOT NULL,

  target_kind text NOT NULL,
  -- THE IDENTIFIER A CUSTOMER USES TO NAME THE THING: the external id for a user, the uuid
  -- for a channel or a message, because those are what the routes take. A uuid for a user
  -- would publish a value no customer has seen and need a join on every read.
  target_id text NOT NULL,

  -- FR-MOD-03's request ID, and the join to the request log. The two logs answer different
  -- questions about one request.
  request_id uuid NOT NULL,

  CONSTRAINT audit_log_actor_kind_check
    CHECK (actor_kind IN ('application', 'user', 'platform')),
  CONSTRAINT audit_log_target_kind_check
    CHECK (target_kind IN ('user', 'message', 'membership', 'channel'))
);

-- THE READ ROUTE'S ONLY ACCESS PATH, AND THE TENANCY PREDICATE'S.
--
-- THE THIRD COLUMN IS THE CURSOR'S TIEBREAKER AND IT IS NOT OPTIONAL. `occurred_at` is not
-- unique — two moderation actions in one instant is what a bulk script does — and a keyset
-- cursor on a non-unique column skips or repeats rows at every page boundary. The
-- precedent this chapter copies had already measured it, in `request-log/reader.ts`:
-- "42 `(environment_id, ts)` pairs in this lane hold more than one row; a `ts`-only
-- comparison skips or repeats all 89 of them." Adding this column after entries exist is a
-- second migration.
CREATE INDEX audit_log_read_idx
  ON audit_log (environment_id, occurred_at DESC, id DESC);

-- IMMUTABLE, MEASURED RATHER THAN DECLARED.
--
-- THE OBVIOUS MECHANISM DOES NOTHING ON THIS DEPLOYMENT. The api connects as `relay` and
-- `relay` is a superuser — `select usesuper from pg_user` answers `t` — so a privilege
-- check is not a check:
--
--     revoke update, delete on probe_immutable from relay;
--     update probe_immutable set v='b' where id=1;      -->  UPDATE 1    the value changed
--
-- Nothing in the schema would have looked wrong. The grant would be in this file and the
-- table would be mutable.
--
-- A TRIGGER FIRES FOR A SUPERUSER. Same probe, same role:
--
--     update probe_immutable set v='c' where id=1;  -->  ERROR: audit entries are append-only
--     delete from probe_immutable where id=1;       -->  ERROR: audit entries are append-only
--                                                        rows after delete attempt: 1
--
-- AND TWO THINGS STILL GET THROUGH, WHICH THE CHAPTER PUBLISHES RATHER THAN OMITS:
--
--     set session_replication_role = replica;
--     update probe_immutable set v='d' where id=1;  -->  UPDATE 1   the trigger did not fire
--     drop trigger probe_guard on probe_immutable;
--     delete from probe_immutable where id=1;       -->  DELETE 1   the row is gone
--
-- So the honest claim is: the log is immutable to the application and to accident, and it
-- is not immutable to somebody holding the database password. This api holds that
-- password. A separate non-superuser role for the application would make the claim much
-- stronger and is a deployment change rather than a chapter.
--
-- Row-level security was considered and answers a different question — a superuser
-- bypasses it too without FORCE. Hash-chaining each entry to its predecessor detects
-- tampering rather than preventing it, which is a larger clause than FR-MOD-03 asks for.
--
-- CONSTITUTION IV, AND THIS IS NOT THE GUARD. `no-trigger-in-migrations.test.ts` forbade
-- every trigger in this directory until chapter 4.18 narrowed it to the sentinel guard by
-- name. The rule was wider than its reason: the guard is a trigger that rejects the api's
-- own legitimate sweeps, and this one refuses writes the api must never make.
CREATE FUNCTION audit_log_refuse_write() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit entries are append-only (FR-MOD-03)'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_refuse_write();
