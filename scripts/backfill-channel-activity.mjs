// Set `channels.last_activity_at` to each channel's real last activity.
//
// Chapter 3.16, T019 — and it is a SCRIPT and not part of migration 0011 for one
// reason: the constitution's workflow section requires migrations to be
// "executable without downtime", and this is a scan.
//
// Adding the column is free. Postgres 11 and later store a constant default in the
// catalogue rather than rewriting the table, so `ALTER TABLE channels ADD COLUMN
// last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()` returns immediately however
// many channels exist. What is not free is giving every existing channel its real
// value, because that is `max(messages.created_at)` per channel — the same
// aggregate research R4 measured at 159 ms over 1,000,000 messages, and the reason
// the column exists at all.
//
// SO IT RUNS AFTERWARDS, IN BATCHES, AND REPORTS. One statement per batch of
// channel ids, each batch its own transaction, so the lock is held for a batch and
// not for the table. A channel with no messages keeps the `now()` the default gave
// it: it has no activity to date from, and dating it from the epoch would sort it
// below every real channel forever.
//
// Idempotent by construction — it computes an absolute value from `messages`, so
// running it twice writes the same timestamps. Safe to re-run after a restore.

// The api's own pool, not a `pg` import: `pg` is a dependency of services/api and
// not of the workspace root, and `createPool` already applies this project's
// DATABASE_URL default of port 15432 — the port the code documents, against a
// compose file that defaults the host to 5432. `scripts/seed-demo-tenant.mjs`
// reaches for the same build output for the same reason.
import { createPool } from "../services/api/dist/db/client.js";

const BATCH = Number(process.env.RELAY_BACKFILL_BATCH ?? 500);
const pool = createPool();

async function main() {
  const started = Date.now();
  const { rows: all } = await pool.query(`SELECT id FROM channels ORDER BY id`);
  let batches = 0;
  let touched = 0;

  for (let i = 0; i < all.length; i += BATCH) {
    const ids = all.slice(i, i + BATCH).map((r) => r.id);
    // `GREATEST` and not a bare max: a channel whose newest message somehow
    // predates the row itself would otherwise move backwards, and the column is
    // NOT NULL so there is always an existing value to compare against.
    const { rowCount } = await pool.query(
      `UPDATE channels c
          SET last_activity_at = GREATEST(
                c.last_activity_at,
                COALESCE(
                  (SELECT max(m.created_at) FROM messages m WHERE m.channel_id = c.id),
                  c.last_activity_at
                )
              )
        WHERE c.id = ANY($1::uuid[])`,
      [ids],
    );
    batches += 1;
    touched += rowCount ?? 0;
  }

  const ms = Date.now() - started;
  // The numbers T019 asks to be recorded, printed rather than estimated.
  console.log(
    `backfill: ${all.length} channels in ${batches} batches of ${BATCH}, ` +
      `${touched} rows written, ${ms} ms`,
  );
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    await pool.end();
    console.error(error);
    process.exitCode = 1;
  });
