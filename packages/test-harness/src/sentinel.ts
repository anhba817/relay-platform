import { createHash } from "node:crypto";

// The sentinel: rows that exist only to be taken (feature 030).
//
// ONE PER TEST FILE, not one shared. Files execute in parallel — no integration
// config overrides `fileParallelism` — so a shared sentinel would mean one file's
// planting deleting rows another file is mid-test against. Per-file planting and a
// shared sentinel are incompatible, and the plan had both until research R12
// (FR-023).
//
// The ids are derived from the file's path, so they are stable across runs and
// unique across files, and a developer reading a failure can tell which file owns
// the rows that were taken.

/** How much bait to plant, per kind.
 *
 * DOUBLE THE LARGEST DEFAULT BATCH in the codebase, so a caller who omits a bound
 * reaches bait before reaching its own rows — which is the whole mechanism.
 *
 * The number is declared here rather than imported, because none of the product's
 * three `BATCH_SIZE` constants is exported and importing `outbox/relay.ts` would
 * drag its whole dependency graph into a setup file. That trade is only acceptable
 * because `bait-size.test.ts` reads those three files and fails if any of them
 * rises past this bound: a literal that goes stale silently is the thing research
 * R7 warned about, and a literal guarded by a test is not silent (FR-002). */
export const MAX_PRODUCT_BATCH = 100;
export const BAIT_ROWS = MAX_PRODUCT_BATCH * 2;

/** The product files whose batch defaults this bound has to dominate. Read by
 * `bait-size.test.ts`; listed here so the two cannot drift apart. */
export const BATCH_SOURCES = [
  "services/api/src/outbox/relay.ts",
  "services/api/src/webhooks/delivery-relay.ts",
  "services/api/src/notifications/notification-relay.ts",
  "services/api/src/db/repository.ts",
] as const;

export interface Sentinel {
  /** The test file that owns these rows, as a repository-relative path. */
  owner: string;
  organisationId: string;
  humanId: string;
  applicationId: string;
  environmentId: string;
  endpointId: string;
  /** `__sentinel__:<owner>`, on every row, so a failure says whose it is. */
  name: string;
}

/** A v4-shaped uuid derived from a string. Deterministic, so a file's sentinel is
 * the same on every run and the delete-then-insert in `plant` is exact. */
function uuidFrom(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  // Set the version and variant nibbles so the value is a well-formed uuid; the
  // remaining bits are the hash. Postgres does not care, but a human comparing
  // this against `data-model.md` should not have to wonder whether it is one.
  const v = "4" + h.slice(13, 16);
  const r = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${r}-${h.slice(20, 32)}`;
}

export function sentinelFor(owner: string): Sentinel {
  const id = (part: string) => uuidFrom(`relay-sentinel/${owner}/${part}`);
  return {
    owner,
    organisationId: id("organisation"),
    humanId: id("human"),
    applicationId: id("application"),
    environmentId: id("environment"),
    endpointId: id("endpoint"),
    name: `__sentinel__:${owner}`,
  };
}

/** The shared sentinel this feature does NOT have, kept as a named export so a
 * reader looking for one finds this comment instead. */
export const SENTINEL = {
  note:
    "There is no shared sentinel. Use sentinelFor(<test file path>) — research R12.",
} as const;

/** Plant this file's bait, replacing whatever is there.
 *
 * IDEMPOTENT BY DELETE-THEN-INSERT rather than `ON CONFLICT`, because three of the
 * four baits are consumable and a re-insert has to restore the *count* as well as
 * the rows. The environment id makes the delete exact, so the seeder cannot become
 * the accumulation it exists to simulate (FR-003).
 *
 * THE CLIENT IS THE CALLER'S PROBLEM, and that is the point. Deleting a sentinel
 * row is exactly what the trigger forbids, so planting needs the exemption — and a
 * connection carrying the exemption must never reach a test, or that test runs
 * unguarded. `setup.ts` opens a dedicated client, passes it here, and closes it
 * before the first test (FR-024, research R12).
 *
 * The four kinds are chosen so that every global operation in the codebase touches
 * at least one:
 *
 *   an endpoint the sweep would disable   -> sweepDisabledEndpoints
 *   due deliveries                        -> drainDueDeliveries
 *   unpublished outbox rows               -> drainOutbox
 *   undelivered notifications             -> drainDisableNotifications
 *
 * The organisation deliberately has NO addressable member. Research R4 measured
 * 200 addressable bait notifications turning one suite's drain into 200 SMTP sends
 * and a ten-second timeout; unaddressable makes each bait row cost one log line,
 * through the branch FR-WHK-07's unaddressable case already covers. */
export async function plant(
  client: { query(sql: string, values?: unknown[]): Promise<unknown> },
  s: Sentinel,
): Promise<void> {
  const q = (sql: string, values?: unknown[]) => client.query(sql, values);

  // Children before parents, so the deletes do not trip a foreign key.
  await q(`DELETE FROM webhook_disable_notifications WHERE environment_id = $1`, [s.environmentId]);
  await q(`DELETE FROM webhook_deliveries            WHERE environment_id = $1`, [s.environmentId]);
  await q(`DELETE FROM outbox                        WHERE subject = $1`, [`${s.name}.bait`]);
  await q(`DELETE FROM webhook_endpoints             WHERE environment_id = $1`, [s.environmentId]);

  // Register before inserting bait: the trigger's WHEN clause tests membership,
  // so an unregistered sentinel is unguarded bait.
  await q(
    `INSERT INTO __sentinel_environments (environment_id, owner) VALUES ($1, $2)
     ON CONFLICT (environment_id) DO UPDATE SET owner = EXCLUDED.owner`,
    [s.environmentId, s.owner],
  );
  await q(
    `INSERT INTO organisations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [s.organisationId, s.name],
  );
  // provider must be 'github' or 'google' (humans_provider_check), and the email
  // is NULL on purpose — see above.
  await q(
    `INSERT INTO humans (id, provider, provider_account_id, email)
     VALUES ($1, 'github', $2, NULL) ON CONFLICT (id) DO NOTHING`,
    [s.humanId, s.name],
  );
  await q(
    `INSERT INTO memberships (organisation_id, human_id, role)
     VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
    [s.organisationId, s.humanId],
  );
  await q(
    `INSERT INTO applications (id, organisation_id, name)
     VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [s.applicationId, s.organisationId, s.name],
  );
  // kind must be 'development' or 'production' (environments_kind_check).
  await q(
    `INSERT INTO environments (id, application_id, kind, signing_secret)
     VALUES ($1, $2, 'development', $3) ON CONFLICT (id) DO NOTHING`,
    [s.environmentId, s.applicationId, `sentinel-not-a-secret-${s.environmentId}`],
  );

  // bait 1: an endpoint the sweep would disable. `disabled_at` and
  // `disabled_reason` must be null together, and `failure_run_started_at` and
  // `failure_run_attempts` must be non-null together — both read off the live
  // schema rather than guessed (webhook_endpoints_disabled_check,
  // webhook_endpoints_failure_run_check).
  await q(
    `INSERT INTO webhook_endpoints
       (id, environment_id, url, event_types, secret_ciphertext, enabled,
        failure_run_started_at, failure_run_attempts, disabled_at, disabled_reason)
     VALUES ($1, $2, $3, '["message.created"]'::jsonb, 'sentinel-not-a-ciphertext',
             true, now() - interval '4 hours', 25, NULL, NULL)`,
    [s.endpointId, s.environmentId, `https://sentinel.invalid/${s.owner}`],
  );

  // bait 2: due deliveries.
  await q(
    `INSERT INTO webhook_deliveries
       (id, environment_id, endpoint_id, event_id, payload, attempt, state, next_attempt_at)
     SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), '{}'::jsonb, 1, 'pending',
            now() - interval '1 hour'
       FROM generate_series(1, $3)`,
    [s.environmentId, s.endpointId, BAIT_ROWS],
  );

  // bait 3: unpublished events. `outbox` carries no environment_id — it is
  // platform bookkeeping — so the subject is what identifies these, and it is
  // also why the trigger cannot guard them (data-model.md).
  await q(
    `INSERT INTO outbox (subject, payload)
     SELECT $1, '{}'::jsonb FROM generate_series(1, $2)`,
    [`${s.name}.bait`, BAIT_ROWS],
  );

  // bait 4: undelivered disablement notifications.
  await q(
    `INSERT INTO webhook_disable_notifications
       (id, environment_id, organisation_id, endpoint_id, disabled_at,
        run_started_at, run_attempts, last_status)
     SELECT gen_random_uuid(), $1, $2, $3, now() - interval '3 hours',
            now() - interval '4 hours', 25, 503
       FROM generate_series(1, $4)`,
    [s.environmentId, s.organisationId, s.endpointId, BAIT_ROWS],
  );
}
