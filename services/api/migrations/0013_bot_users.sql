-- Chapter 3.17 — the sender a message never had.
--
-- FR-MSG-13 has said since v1 that the system "shall support sending a message on
-- behalf of a bot user of that tenant via API key" — and until this chapter it read
-- "on behalf of any user", satisfied by naming nobody. Chapter 3.3 decided that when
-- nothing read the sender. Three chapters since have made the sender decide what is
-- rendered, what is delivered and what may be seen, so a message with no sender became
-- a row those three chapters cannot describe.
--
-- TWO COLUMNS, NOT A SECOND TABLE. `users` is what every reader built since chapter
-- 3.15 already reads. A `bots` table would have meant teaching each of them a second
-- place to look, and `messages.user_id` would have had to reference one of two tables.
--
-- NO BACKFILL, and that is measured rather than assumed. `ADD COLUMN ... NOT NULL
-- DEFAULT` is metadata-only on Postgres 11+ — the existing rows are not rewritten —
-- which chapter 3.16 measured for `last_activity_at` on the same table.
ALTER TABLE users
  ADD COLUMN kind        TEXT NOT NULL DEFAULT 'person',
  ADD COLUMN description TEXT;

-- THE FIRST CHECK IS THE VOCABULARY. `channels_type_check` guards `channels.type`,
-- `members_role_check` guards a channel member's role and `memberships_role_check` an
-- organisation member's — one word apart is how `admin` nearly reached a channel
-- member (chapter 3.15), so each of these constraints names its siblings.
--
-- `environments.kind` is the one column called `kind` that has no CHECK: it has held
-- 'development' or 'production' since chapter 2.1 (FR-TEN-04) and cannot refuse a typo.
-- Not fixed here, because a constraint on a column seventeen chapters old is not this
-- chapter's change, and an unmentioned asymmetry is one the next reader assumes away.
ALTER TABLE users
  ADD CONSTRAINT users_kind_check CHECK (kind IN ('person','bot'));

-- THE SECOND CHECK IS THE REQUIREMENT, not a nicety.
--
-- It makes a bot without a description UNREPRESENTABLE rather than merely refused. Zod
-- refuses one at the boundary (FR-002, FR-004b) and this refuses one from any writer —
-- a migration, a backfill, a psql session. A description is what turns an opaque sender
-- into an answerable one: a customer's support tooling can say what posted and why, and
-- a bot without that is the anonymous sender this chapter exists to remove.
--
-- IT ALSO DECIDES WHAT DELETION MAY DO. FR-027 clears `display_name`, `avatar_url` and
-- `metadata` when a user is deleted; clearing `description` too would violate this
-- constraint and make a bot the one kind of user that cannot be deleted. So a bot's
-- description is not profile data (FR-004a), and this line is why.
ALTER TABLE users
  ADD CONSTRAINT users_bot_description_check
  CHECK (kind <> 'bot' OR description IS NOT NULL);
