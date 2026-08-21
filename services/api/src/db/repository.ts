import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";

import { DEFAULT_LIMITS, type LimitedOperation } from "../limits/policy";
import type { Db } from "./client";
import {
  apiKeys,
  applications,
  channels,
  consumedEvents,
  environments,
  humans,
  members,
  memberships,
  messages,
  organisations,
  outbox,
  quotaNotifications,
  usageActiveUsers,
  usagePeriods,
  users,
  webhookDeadLetters,
  webhookDeliveries,
  webhookDisableNotifications,
  webhookEndpoints,
} from "./schema";
import { messageCreatedEvent } from "../outbox/event";
import { capsFor, type Caps } from "../quotas/config";
import { thresholdsCrossed } from "../quotas/policy";
import { QuotaExceededError, type Dimension } from "../quotas/quota.error";
import { periodOf } from "../quotas/period";
import { nextAttemptAt } from "../webhooks/schedule";
import {
  DISABLE_AFTER_MS,
  DISABLE_MIN_ATTEMPTS,
  disableReason,
  runWindowMs,
  shouldDisable,
} from "../webhooks/disable";
import { activeSigningSecrets } from "../webhooks/secret";
import {
  mintApiKey,
  parseApiKeyCredential,
  prefixMatchesKind,
  secretMatches,
  type EnvironmentKind,
} from "../auth/api-key";

// The repository layer — the ONE place data access lives (ADR-04's single
// writer, constitution I). Two surfaces with a bright line between them:
//
//   createEnvironment / provisionOrganisation — the ADMIN surface. These
//   create tenants, so they are the only operations here that are not
//   tenant-scoped. As of chapter 3.1 they build the whole container stack:
//   organisation -> application -> environment, with no stubs left.
//
//   Repository — everything else. The constructor REQUIRES an
//   environment_id; every query is scoped by it HERE, in one home — never
//   at call sites. Cross-tenant reads return null/empty: no data, and no
//   reveal that the foreign id even exists (FR-TEN-05).
//
// Drizzle is the query engine inside this layer (ADR-16): queries keep
// their SQL shape and gain end-to-end types. Where the builder falls short,
// a raw SQL island is permitted — inside the layer, never outside it.
//
// All primary keys are generated app-side (crypto.randomUUID) — the SAD's
// SQL declares no id defaults, and the migration adds none.

export interface Environment {
  id: string;
  kind: "development" | "production";
}

export async function createEnvironment(
  db: Db,
  { name, kind = "development" }: { name: string; kind?: Environment["kind"] },
): Promise<Environment> {
  const organisationId = randomUUID();
  const applicationId = randomUUID();
  const environmentId = randomUUID();
  // The admin surface writes through the same Db handle but carries no
  // tenant scope — it is the operation that MINTS the scope.
  //
  // Chapter 3.1 added the organisation above the application, and this
  // function had to grow with it the same day: `applications.organisation_id`
  // is NOT NULL, and this is the function every Part 2 suite, the e2e harness
  // and three walk scripts use to make a tenant. A schema change whose only
  // writer is left behind is not a migration, it is an outage.
  await db.execute(
    sql`INSERT INTO organisations (id, name) VALUES (${organisationId}, ${name})`,
  );
  await db.execute(
    sql`INSERT INTO applications (id, organisation_id, name)
        VALUES (${applicationId}, ${organisationId}, ${name})`,
  );
  await db.execute(
    sql`INSERT INTO environments (id, application_id, kind, signing_secret)
        VALUES (${environmentId}, ${applicationId}, ${kind}, ${randomUUID()})`,
  );
  return { id: environmentId, kind };
}

// ---------------------------------------------------------------------------
// Credentials (chapter 3.2). Part of the ADMIN surface, and that placement is
// the interesting bit: authentication has to resolve a tenant BEFORE one is
// known, so these are the only queries in this file that cannot be scoped by an
// environment. They are the operations that PRODUCE the scope everything else
// is bound by — which is why they sit beside createEnvironment rather than
// inside the request-scoped class below.
// ---------------------------------------------------------------------------

/** The parts of a minted key a caller may see. `credential` is the only time
 * the secret exists outside a hash (FR-AUT-02); lose it and the answer is a new
 * key, not a lookup. */
export interface CreatedApiKey {
  id: string;
  credential: string;
  publicId: string;
  prefix: string;
}

/** A writer that may be the pool or a transaction. `provisionOrganisation`
 * mints the first key inside its transaction, so this cannot take `Db` alone —
 * a key written outside that transaction could survive a rolled-back tenant. */
type Writer = Pick<Db, "insert" | "select" | "update">;

/** FR-AUT-01. The kind is NOT a parameter: it is read from the environment, so
 * the prefix and the environment can never disagree at creation time. */
export async function createApiKey(
  db: Writer,
  { environmentId, name }: { environmentId: string; name?: string },
): Promise<CreatedApiKey> {
  const [environment] = await db
    .select({ kind: sql<EnvironmentKind>`${environments.kind}` })
    .from(environments)
    .where(eq(environments.id, environmentId));
  if (!environment) {
    throw new Error(`no such environment: ${environmentId}`);
  }
  const minted = mintApiKey(environment.kind);
  const id = randomUUID();
  await db.insert(apiKeys).values({
    id,
    environmentId,
    publicId: minted.publicId,
    secretHash: minted.secretHash,
    salt: minted.salt,
    prefix: minted.prefix,
    name: name ?? null,
  });
  return {
    id,
    credential: minted.credential,
    publicId: minted.publicId,
    prefix: minted.prefix,
  };
}

/** What a verified key resolves to. Deliberately not the row: nothing outside
 * this function needs the hash, the salt, or the name. */
export interface AuthenticatedKey {
  keyId: string;
  environmentId: string;
}

/** One indexed lookup, then a constant-time comparison. No cache, on purpose:
 * FR-AUT-05's revocation bound is true by construction when verification is
 * live, on every instance, with nothing to invalidate (research R7).
 *
 * Returns null for every failure — unknown, revoked, wrong secret, mismatched
 * prefix — because a caller learns nothing from being told which. */
export async function authenticateApiKey(
  db: Db,
  credential: string,
): Promise<AuthenticatedKey | null> {
  const parsed = parseApiKeyCredential(credential);
  if (!parsed) return null;

  const [row] = await db
    .select({
      id: apiKeys.id,
      environmentId: apiKeys.environmentId,
      secretHash: apiKeys.secretHash,
      salt: apiKeys.salt,
      prefix: apiKeys.prefix,
      revokedAt: apiKeys.revokedAt,
      kind: sql<EnvironmentKind>`${environments.kind}`,
    })
    .from(apiKeys)
    .innerJoin(environments, eq(environments.id, apiKeys.environmentId))
    .where(eq(apiKeys.publicId, parsed.publicId));

  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (!secretMatches(parsed.secret, row.salt, row.secretHash)) return null;
  // A row whose prefix disagrees with its environment's kind is a data fault,
  // not a credential to trust. Storing the prefix is what makes this checkable.
  if (!prefixMatchesKind(row.prefix, row.kind)) return null;

  // Touched at most once a minute rather than on every request: the column is
  // for spotting a key nobody rotated, and that question does not need
  // second-level precision or a write per authenticated call.
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, row.id),
        sql`(${apiKeys.lastUsedAt} IS NULL OR ${apiKeys.lastUsedAt} < now() - interval '1 minute')`,
      ),
    );

  return { keyId: row.id, environmentId: row.environmentId };
}

/** FR-AUT-05. A timestamp, not a DELETE: the row is the record of what once had
 * access, and the credential stops working on the next request either way. */
export async function revokeApiKey(db: Db, keyId: string): Promise<boolean> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), sql`${apiKeys.revokedAt} IS NULL`))
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}

/** The environment's own signing secret, which is what makes an end-user token
 * verifiable — and what keeps it verifiable ONLY by the service that owns the
 * database (ADR-05, research R1). The gateway never sees this. */
export async function environmentSigningSecret(
  db: Db,
  environmentId: string,
): Promise<{ signingSecret: string; kind: EnvironmentKind } | null> {
  const [row] = await db
    .select({
      signingSecret: environments.signingSecret,
      kind: sql<EnvironmentKind>`${environments.kind}`,
    })
    .from(environments)
    .where(eq(environments.id, environmentId));
  return row ?? null;
}

/** An environment's rate limits, with nulls resolved to the documented defaults
 * (chapter 3.8, FR-RTL-04, research R26).
 *
 * RESOLVED HERE RATHER THAN AT THE CALL SITE, because "null means use the
 * default" is a property of the column and a caller that had to remember it
 * would eventually forget. Null is NOT zero: zero means refuse everything, and an
 * environment can be switched off deliberately.
 *
 * Returns null for an environment that does not exist, which the caller must tell
 * apart from an environment with default limits — a request whose credential
 * named a missing environment is not a request to serve generously. */
export async function environmentLimits(
  db: Db,
  environmentId: string,
): Promise<Record<LimitedOperation, number> | null> {
  const [row] = await db
    .select({
      rest: environments.restLimitPerMinute,
      send: environments.sendLimitPerMinute,
      connect: environments.connectLimitPerMinute,
    })
    .from(environments)
    .where(eq(environments.id, environmentId));
  if (!row) return null;
  return {
    rest: row.rest ?? DEFAULT_LIMITS.rest,
    send: row.send ?? DEFAULT_LIMITS.send,
    connect: row.connect ?? DEFAULT_LIMITS.connect,
  };
}

/** What an environment has consumed in a period, and what it is allowed
 * (chapter 3.10, FR-RTL-05).
 *
 * ZEROS FOR A PERIOD WITH NO ROWS, not null and not an error. An environment that
 * has sent nothing has used nothing, and making every caller tell "no usage" apart
 * from "no row" would push a schema detail into each of them.
 *
 * A NULL QUOTA IS CARRIED THROUGH AS NULL rather than resolved to `Infinity` or
 * `-1`. The absent state stays absent all the way to the reader — the same rule
 * chapter 3.8's nullable limit columns encode, and the reason `capsFor` returns
 * `null` rather than a sentinel.
 *
 * Admin surface: takes an environment id rather than being scoped by construction,
 * because the relay and the internal route both read it on behalf of the platform.
 * Bounded by an id, so it crosses environments and cannot run away (the third
 * category in this file's taxonomy). */
export async function usageFor(
  db: Db,
  environmentId: string,
  period: string,
): Promise<{
  period: string;
  messagesSent: number;
  activeUsers: number;
  messageQuota: number | null;
  activeUserQuota: number | null;
}> {
  const [row] = await db
    .select({
      messagesSent: usagePeriods.messagesSent,
      quotaConfig: environments.quotaConfig,
    })
    .from(environments)
    .leftJoin(
      usagePeriods,
      and(
        eq(usagePeriods.environmentId, environments.id),
        eq(usagePeriods.period, period),
      ),
    )
    .where(eq(environments.id, environmentId));

  const [users] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usageActiveUsers)
    .where(
      and(
        eq(usageActiveUsers.environmentId, environmentId),
        eq(usageActiveUsers.period, period),
      ),
    );

  return {
    period,
    messagesSent: row?.messagesSent ?? 0,
    activeUsers: users?.n ?? 0,
    messageQuota: capsFor(row?.quotaConfig, "messages").caps.hard,
    activeUserQuota: capsFor(row?.quotaConfig, "active_users").caps.hard,
  };
}

/** One quota crossing waiting to be emailed. */
export interface QuotaNotificationRow {
  id: string;
  organisationId: string;
  environmentName: string;
  period: string;
  dimension: string;
  threshold: number;
  quota: number;
  usageAtCrossing: number;
  /** Whether a hard cap is in force for this dimension right now — which decides
   * whether the email says sends have stopped or that nothing has changed. Read
   * at delivery rather than stored, because it is a statement about the present
   * and the operator may have raised the cap since. */
  hardCapInForce: boolean;
}

/** The outbox drain, a FOURTH time (chapter 3.10) — after 3.3's events, 3.5's
 * deliveries and 3.9's disablement emails. Same claim predicate, same
 * per-row error handling, same required batch size.
 *
 * PER-ROW `try`/`catch` WITH A REQUIRED `onError`, and the default that used to
 * sit on 3.9's version is not repeated here: it discarded a row's failure with no
 * log line, and feature 030's R48 removed it after finding it as this file's last
 * uncovered function. One bad recipient must not abort the batch and must not
 * vanish either. */
export async function drainQuotaNotifications(
  db: Db,
  limit: number,
  deliver: (row: QuotaNotificationRow) => Promise<void>,
  onError: (row: QuotaNotificationRow, error: unknown) => void,
): Promise<number> {
  return db.transaction(async (tx) => {
    const claimed = (await tx.execute(
      sql`SELECT q.id                AS "id",
                 q.organisation_id   AS "organisationId",
                 a.name || ' / ' || e.kind AS "environmentName",
                 to_char(q.period, 'YYYY-MM-DD') AS "period",
                 q.dimension         AS "dimension",
                 q.threshold         AS "threshold",
                 q.quota             AS "quota",
                 q.usage_at_crossing AS "usageAtCrossing",
                 (e.quota_config #>> ('{' || q.dimension || ',hard}')::text[])
                   IS NOT NULL       AS "hardCapInForce"
            FROM quota_notifications q
            JOIN environments e ON e.id = q.environment_id
            JOIN applications a ON a.id = e.application_id
           WHERE q.delivered_at IS NULL
           ORDER BY q.crossed_at
           LIMIT ${limit}
             FOR UPDATE OF q SKIP LOCKED`,
    )) as unknown as { rows: QuotaNotificationRow[] };

    let delivered = 0;
    for (const row of claimed.rows) {
      try {
        await deliver(row);
        await tx.execute(
          sql`UPDATE quota_notifications SET delivered_at = now(), last_error = NULL
               WHERE id = ${row.id}::uuid`,
        );
        delivered += 1;
      } catch (error) {
        onError(row, error);
        await tx.execute(
          sql`UPDATE quota_notifications SET last_error = ${String(error)}
               WHERE id = ${row.id}::uuid`,
        );
      }
    }
    return delivered;
  });
}

// ---------------------------------------------------------------------------
// The outbox drain (chapter 3.3, ADR-06). Part of the ADMIN surface for the
// same reason the credential lookup is: it runs on behalf of the platform
// rather than of a tenant, and it is deliberately NOT scoped by environment —
// one relay drains every environment's events, because an outbox row is work
// the platform owes itself.
//
// The SQL lives here rather than in the relay module because the query engine
// lives inside this layer and nowhere else (constitution I, ADR-16). The relay
// supplies WHAT to do with a row; this supplies HOW rows are claimed and
// retired.
// ---------------------------------------------------------------------------

export interface OutboxRow {
  id: number;
  subject: string;
  payload: unknown;
}

/** Claim up to `limit` unpublished rows, hand each to `publish`, and mark the
 * ones that succeeded — all inside ONE transaction.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes a second relay safe: competing
 * drainers skip each other's claimed rows instead of blocking on them, so
 * horizontal scaling is a property of this query rather than of a coordination
 * mechanism nobody wants to operate (ADR-06).
 *
 * PUBLISH THEN MARK, never the reverse. A crash between the two republishes on
 * restart, which is at-least-once and is the accepted cost. Marking first would
 * make it at-most-once and reintroduce exactly the loss this chapter removes
 * (research R3).
 *
 * A publisher that throws aborts the batch: rows already published in this
 * batch are marked, the failing row and everything after it stay pending, and
 * the next pass tries again from there.
 */
export async function drainOutbox(
  db: Db,
  limit: number,
  publish: (row: OutboxRow) => Promise<void>,
): Promise<number> {
  return db.transaction(async (tx) => {
    const claimed = (await tx.execute(
      sql`SELECT id, subject, payload
            FROM outbox
           WHERE published_at IS NULL
           ORDER BY created_at, id
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED`,
    )) as unknown as { rows: OutboxRow[] };

    const published: number[] = [];
    try {
      for (const row of claimed.rows) {
        await publish(row);
        published.push(row.id);
      }
    } finally {
      // In the `finally` on purpose: whatever went wrong with row N+1, rows 1..N
      // really did reach the broker and must not be sent a second time by this
      // instance's next pass.
      if (published.length > 0) {
        await tx.execute(
          sql`UPDATE outbox SET published_at = now()
               WHERE id = ANY(${sql.raw(`ARRAY[${published.join(",")}]::bigint[]`)})`,
        );
      }
    }
    return published.length;
  });
}

// ---------------------------------------------------------------------------
// The disablement notifications (chapter 3.8, FR-WHK-07 to FR-WHK-07). THE OUTBOX A
// THIRD TIME — after chapter 3.3's events and chapter 3.5's deliveries — and
// this one needed no migration at all: chapter 3.6 gave the table a
// `delivered_at` column and left it null throughout, which is a claim predicate
// already written down.
//
// The backlog 3.6 accumulated therefore drains on the first run with NO SPECIAL
// HANDLING. By the predicate's own definition those rows are undelivered work,
// and code that treated them as a migration would be code asserting they are
// different when they are not (FR-WHK-07).
//
// Admin surface, like `drainOutbox`: one relay serves every environment, because
// a notification is an obligation the platform owes rather than tenant traffic.
// ---------------------------------------------------------------------------

export interface DisableNotificationRow {
  id: string;
  organisationId: string;
  /** What to call the environment in an email. `environments` has a `kind` —
   * development, staging, production — and no name of its own, so on its own it
   * is ambiguous for an organisation with four applications. The application's
   * name and the kind together are the shortest thing a reader can act on. */
  environmentName: string;
  endpointUrl: string;
  disabledAt: Date;
  runStartedAt: Date;
  runAttempts: number;
  lastStatus: number | null;
  lastError: string | null;
}

/** Claim up to `limit` undelivered notifications, hand each to `deliver`, and
 * mark the ones that went out — all inside ONE transaction.
 *
 * AN EXPLICIT LIMIT, no default. Chapter 3.7's baseline found four suites broken
 * by tests that asserted local facts about a global, oldest-first operation, and
 * this is another global operation: a caller that wants only its own rows drained
 * has to say how many, and a test that forgets ends up asserting about somebody
 * else's fixture.
 *
 * SEND THEN MARK: a crash between the two resends one email, which is the
 * accepted cost, and marking first would lose it silently — a notification
 * nobody received is the failure FR-WHK-07 exists to prevent.
 *
 * PER-ROW ISOLATION, and this is where it departs from `drainOutbox` one screen
 * up. That one lets a failing publish abort the batch, on the reasoning that the
 * broker is either up or down and a partial batch means down. An email is not
 * like that: one address a server refuses is one address, and letting it abort
 * the batch would make it abort EVERY batch — claimed first because it is
 * oldest, throwing, rolling back, and no notification behind it ever going out.
 * Head-of-line blocking, permanent, from one bad recipient.
 *
 * So a row that throws is reported through `onError` and simply not marked. It
 * stays claimable and the rows behind it still go.
 *
 * A NOTE ON WHY THE ORDERING IS OBSERVABLE AT ALL. It was not, at first: with
 * the mark in a `finally` and the throw escaping the transaction callback, the
 * transaction rolled back and undid the mark, so marking BEFORE the send and
 * marking after it produced identical behaviour. The chapter's own sabotage
 * mutation could not fail (research R44). Catching per row is what makes the two
 * different, because now nothing rolls back.
 */
export async function drainDisableNotifications(
  db: Db,
  limit: number,
  deliver: (row: DisableNotificationRow) => Promise<void>,
  /** REQUIRED, as of feature 030, and for a sharper reason than `limit`'s.
   *
   * It carried `= () => {}`, a default that DISCARDS a row's failure without a
   * log line — the swallowed-refusal shape twice over (research R13, R39). No
   * caller in the tree has ever used it: `notification-relay.ts` is the only one
   * and it has always passed a handler. So the default was dead code that existed
   * only to make forgetting the handler silent.
   *
   * It also had a second life as the file's last uncovered function, which is how
   * it was found: `repository.ts` measures 98.7% functions against a ratchet of
   * 100, and it measured that before this feature touched anything (research
   * R47). */
  onError: (row: DisableNotificationRow, error: unknown) => void,
): Promise<number> {
  return db.transaction(async (tx) => {
    const claimed = (await tx.execute(
      sql`SELECT n.id                AS "id",
                 n.organisation_id   AS "organisationId",
                 a.name || ' / ' || e.kind AS "environmentName",
                 w.url               AS "endpointUrl",
                 n.disabled_at       AS "disabledAt",
                 n.run_started_at    AS "runStartedAt",
                 n.run_attempts      AS "runAttempts",
                 n.last_status       AS "lastStatus",
                 n.last_error        AS "lastError"
            FROM webhook_disable_notifications n
            JOIN environments e ON e.id = n.environment_id
            JOIN applications a ON a.id = e.application_id
            JOIN webhook_endpoints w ON w.id = n.endpoint_id
           WHERE n.delivered_at IS NULL
           ORDER BY n.disabled_at, n.id
           LIMIT ${limit}
             FOR UPDATE OF n SKIP LOCKED`,
    )) as unknown as {
      rows: (Omit<DisableNotificationRow, "disabledAt" | "runStartedAt"> & {
        disabledAt: string | Date;
        runStartedAt: string | Date;
      })[];
    };

    const delivered: string[] = [];
    for (const raw of claimed.rows) {
      // Timestamps back as `Date`, not as whatever the driver felt like. Raw
      // SQL through `execute` skips drizzle's column mapping, and a timestamptz
      // arrives as a string — which reaches the mailer as an object with no
      // `getTime`, one call later and one file away. Coerced here, at the
      // boundary that produced it, rather than defended against downstream.
      const row: DisableNotificationRow = {
        ...raw,
        disabledAt: new Date(raw.disabledAt),
        runStartedAt: new Date(raw.runStartedAt),
      };
      try {
        await deliver(row);
        delivered.push(row.id);
      } catch (error) {
        // Not marked. The row stays claimable and the next pass tries it again,
        // which is the whole reason this is a table rather than a call.
        onError(row, error);
      }
    }

    if (delivered.length > 0) {
      // The builder rather than raw SQL, unlike the outbox drain one screen up.
      // That one interpolates `ARRAY[…]::bigint[]` through `sql.raw` because its
      // ids are integers; these are uuids, and `sql` renders a JS array as a
      // comma-separated parameter list — which Postgres reads as a row
      // expression and rejects with "record type has too many columns".
      await tx
        .update(webhookDisableNotifications)
        .set({ deliveredAt: new Date() })
        .where(inArray(webhookDisableNotifications.id, delivered));
    }
    return delivered.length;
  });
}

/** The addresses to notify for an organisation, at SEND TIME (FR-WHK-07).
 *
 * Resolved from the row's `organisation_id`, which chapter 3.6 denormalised onto
 * the notification precisely so this lookup could not follow the endpoint's
 * CURRENT owner. An application that moved between organisations after the
 * disablement must not silently retarget an obligation already owed to somebody
 * else — 3.6 wrote the reason down and this is the first code to depend on it.
 *
 * `humans.email` is nullable, so this can legitimately return nothing. That is a
 * branch the caller has to handle, not a case that cannot arise.
 *
 * EVERY member, not only the owners. `memberships.role` is one of owner, admin
 * or member, and picking a subset here would be this chapter inventing a
 * notification-preferences model — which is product, and belongs to whichever
 * chapter builds preferences. Everyone who can see the endpoint hears that it
 * stopped. */
export async function organisationRecipients(
  db: Db,
  organisationId: string,
): Promise<string[]> {
  const result = (await db.execute(
    sql`SELECT DISTINCT h.email AS "email"
          FROM memberships m
          JOIN humans h ON h.id = m.human_id
         WHERE m.organisation_id = ${organisationId}
           AND h.email IS NOT NULL
         ORDER BY h.email`,
  )) as unknown as { rows: { email: string }[] };
  return result.rows.map((row) => row.email);
}

/** How far behind the relay is. The single number worth alarming on later, and
 * the one the chapter shows going up while the broker is down. */
/** The name this consumer claims events under. One name, because the ledger is
 * keyed per consumer and the dispatcher is one consumer however many processes
 * run it (chapter 3.4's data model). */
export const DISPATCHER_CONSUMER = "dispatcher";

/** Turn one event into one delivery per matching endpoint — **in one
 * transaction** (chapter 3.5, research R2).
 *
 * Admin surface, like `drainOutbox`: one dispatcher serves every environment, so
 * this cannot go through the scoped Repository. It is still safe, because the
 * environment comes from the EVENT rather than from a caller's parameter.
 *
 * The claim is chapter 3.4's, unchanged, and it is doing more work here than it
 * did there. The broker will redeliver — that is what at-least-once means — and
 * an event expanded twice would double every webhook it produced. Because the
 * claim and the N inserts share a transaction, "expansion runs exactly once"
 * stops being something the code must be careful about and becomes a property of
 * the database.
 *
 * An event no endpoint subscribes to is still CLAIMED, with zero rows created.
 * Leaving it unclaimed would make every redelivery re-ask the same question
 * forever. */
export async function expandEventToDeliveries(
  db: Db,
  event: {
    eventId: string;
    environmentId: string;
    type: string;
    payload: unknown;
  },
): Promise<{ created: number; duplicate: boolean }> {
  let created = 0;
  const result = await claimEvent(
    db,
    DISPATCHER_CONSUMER,
    event.eventId,
    async () => {
      const endpoints = await db
        .select({
          id: webhookEndpoints.id,
          eventTypes: webhookEndpoints.eventTypes,
        })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.environmentId, event.environmentId),
            eq(webhookEndpoints.enabled, true),
            isNull(webhookEndpoints.deletedAt),
          ),
        );

      // Subscription filtering happens HERE rather than at delivery time: a
      // delivery row that exists and is never sent is a retry schedule with a
      // permanent no-op in it, and an operator reading the table would have no
      // way to tell it from work that is stuck.
      const matching = endpoints.filter((e) =>
        (e.eventTypes as string[]).includes(event.type),
      );
      if (matching.length === 0) return;

      await db.insert(webhookDeliveries).values(
        matching.map((endpoint) => ({
          id: randomUUID(),
          environmentId: event.environmentId,
          endpointId: endpoint.id,
          eventId: event.eventId,
          payload: event.payload,
        })),
      );
      created = matching.length;
    },
  );
  return { created, duplicate: result === "duplicate" };
}

/** What the api did with an attempt's outcome. */
export type DeliveryOutcome = "delivered" | "rescheduled" | "dead_lettered";

/** Record one attempt's result, and decide what happens next — **in one
 * transaction** (chapter 3.5).
 *
 * The three terminal paths are here together on purpose. Splitting "record the
 * failure" from "schedule the next attempt" would allow a delivery marked failed
 * with no next attempt scheduled: a webhook that stops without anyone being
 * told, which is the failure mode a retry system exists to prevent.
 *
 * IDEMPOTENT on `(delivery_id, attempt)`. The dispatcher posts, then reports,
 * then acknowledges; a crash between the POST and the acknowledgement means the
 * delivery is redelivered and reported again. Recognising the repeat and
 * returning the same answer is what makes that redelivery harmless — the POST
 * itself may duplicate, and the customer absorbs it on the event id, but the
 * SCHEDULE must not advance twice for one attempt or the tiers would collapse.
 */
/** Open, extend or clear an endpoint's failure run, and disable it if the run has
 * gone on long enough (chapter 3.6, FR-006, FR-007).
 *
 * Runs INSIDE the transaction that records the outcome, and takes
 * `SELECT … FOR UPDATE` on the endpoint row.
 *
 * WHAT THAT LOCK IS ACTUALLY FOR, corrected by the sabotage battery. The comment
 * here used to say it was "the whole of FR-008's concurrency story" — that without
 * it, two dispatcher instances reporting outcomes for the same endpoint at the same
 * moment would both decide to disable and produce two notifications. Dropping the
 * lock and running the whole suite produced 46 passes. The claim was wrong: the
 * `enabled = true` predicate in `disableEndpoint`'s update is sufficient for
 * at-most-once on its own, and the lock was being credited for the predicate's
 * work.
 *
 * The lock protects the COUNTER. Under READ COMMITTED both transactions read
 * `runAttempts = 4`, both compute 5, and the second UPDATE waits for the first and
 * then overwrites it with 5. That is a lost update, and the run undercounts by one
 * per collision. Nothing reports it, nothing fails, and the endpoint quietly needs
 * an extra failure to reach FR-007's floor of five — a threshold harder to reach
 * than the requirement says, which is the kind of defect that survives for years.
 *
 * The lock is per endpoint and held for one small update, so two customers never
 * contend (research R2).
 *
 * Lock ORDER is delivery-then-endpoint, everywhere, without exception. The caller
 * has already locked the delivery row; anything that took these two in the other
 * order would deadlock against this under concurrency, and a deadlock found in
 * production is a deadlock found by a customer.
 *
 * Returns what it did, so the caller can report it and the tests can assert on it
 * without reading the row back. */
async function applyFailureRun(
  tx: Db,
  input: {
    endpointId: string;
    /** Did this attempt fail? A success clears the run outright. */
    failed: boolean;
    status: number | null;
    error: string | null;
  },
): Promise<{ disabled: boolean }> {
  const [endpoint] = await tx
    .select({
      id: webhookEndpoints.id,
      environmentId: webhookEndpoints.environmentId,
      enabled: webhookEndpoints.enabled,
      runStartedAt: webhookEndpoints.failureRunStartedAt,
      runAttempts: webhookEndpoints.failureRunAttempts,
    })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, input.endpointId))
    .for("update");

  // The endpoint was deleted between the delivery being claimed and its outcome
  // being reported. Nothing to track and nothing to disable; the delivery's own
  // state has already been settled by the caller.
  if (!endpoint) return { disabled: false };

  if (!input.failed) {
    // ANY SUCCESS CLEARS THE RUN (FR-006). This is why an endpoint that succeeds
    // once an hour is never disabled, and it is deliberately generous: a platform
    // that switches off endpoints which sometimes work is a worse failure than one
    // that keeps trying. Written unconditionally rather than behind a "was there a
    // run" check — the update is the same cost either way, and the check is one
    // more thing to get wrong.
    await tx
      .update(webhookEndpoints)
      .set({ failureRunStartedAt: null, failureRunAttempts: null })
      .where(eq(webhookEndpoints.id, endpoint.id));
    return { disabled: false };
  }

  // Read the clock ONCE, from the database, so the window and the timestamps it is
  // compared against come from the same source. An api process whose clock differs
  // from Postgres's would otherwise measure a window against somebody else's idea
  // of now.
  // Coerced, not trusted. A raw `execute` hands back whatever the driver made of
  // the column, and for `timestamptz` that is a string here rather than a Date —
  // which drizzle then refuses to write back, with `value.toISOString is not a
  // function` from deep inside its timestamp mapper and no mention of this line.
  const [clock] = (await tx.execute(sql`SELECT now() AS now`))
    .rows as { now: string | Date }[];
  const now = new Date(clock!.now);

  const runStartedAt = endpoint.runStartedAt ?? now;
  const runAttempts = (endpoint.runAttempts ?? 0) + 1;

  await tx
    .update(webhookEndpoints)
    .set({ failureRunStartedAt: runStartedAt, failureRunAttempts: runAttempts })
    .where(eq(webhookEndpoints.id, endpoint.id));

  if (!shouldDisable({ runStartedAt, runAttempts, now })) {
    return { disabled: false };
  }

  return disableEndpoint(tx, {
    endpointId: endpoint.id,
    environmentId: endpoint.environmentId,
    runStartedAt,
    runAttempts,
    now,
    status: input.status,
    error: input.error,
  });
}

/** Switch an endpoint off, once, and record the obligation to tell somebody
 * (FR-007, FR-008, FR-011).
 *
 * AT MOST ONCE PER RUN, and it is the STATEMENT that enforces it rather than a
 * check somebody has to remember to write: the update carries `enabled = true` in
 * its predicate, so a second disable matches zero rows and the notification below
 * is never reached. Both triggers call this, so both inherit the property — which
 * is contract invariant 12, and the reason there can safely be two of them. */
async function disableEndpoint(
  tx: Db,
  input: {
    endpointId: string;
    environmentId: string;
    runStartedAt: Date;
    runAttempts: number;
    now: Date;
    status: number | null;
    error: string | null;
  },
): Promise<{ disabled: boolean }> {
  const windowMs = runWindowMs({ runStartedAt: input.runStartedAt, now: input.now });
  const reason = disableReason({
    runAttempts: input.runAttempts,
    windowMs,
    lastStatus: input.status,
    lastError: input.error,
  });

  const updated = (await tx.execute(sql`
    UPDATE webhook_endpoints
       SET enabled = false,
           disabled_at = ${input.now},
           disabled_reason = ${reason}
     WHERE id = ${input.endpointId}
       AND enabled = true
     RETURNING id`)) as unknown as { rows: { id: string }[] };

  // Zero rows means somebody else got there first — a concurrent outcome report,
  // or the sweep, or a customer who happened to pause the endpoint themselves. In
  // every case the answer is the same: this call disabled nothing, so it owes no
  // notification.
  if (updated.rows.length === 0) return { disabled: false };

  // The organisation is resolved HERE, at write time, through the two hops that
  // already exist: environments.application_id → applications.organisation_id. It
  // is stored rather than joined for later because this row records an obligation
  // AS IT STOOD, and an application moving between organisations afterwards must
  // not silently retarget a notification already owed to somebody else.
  const [owner] = await tx
    .select({ organisationId: applications.organisationId })
    .from(environments)
    .innerJoin(applications, eq(environments.applicationId, applications.id))
    .where(eq(environments.id, input.environmentId));

  await tx.insert(webhookDisableNotifications).values({
    id: randomUUID(),
    environmentId: input.environmentId,
    organisationId: owner!.organisationId,
    endpointId: input.endpointId,
    disabledAt: input.now,
    runStartedAt: input.runStartedAt,
    runAttempts: input.runAttempts,
    lastStatus: input.status,
    lastError: input.error,
    // NOT SET, and that is the point. FR-WHK-07 asks for the organisation to be
    // notified by email and this platform has no email; `delivered_at` exists in
    // order to be null until a transport does.
  });

  return { disabled: true };
}

/** What one recorded outcome yields its caller.
 *
 * The four identifiers are here because the ATTEMPT EVENT needs them and the
 * dispatcher does not hold them: it knows a delivery id, a status and a latency,
 * and nothing about which environment or event that delivery belongs to. Reading
 * them back out with a second query would be a second query for data this
 * transaction already had in hand.
 *
 * `recorded` is the field the analytics publish is conditional on. See the
 * idempotent-replay branch below. */
export interface RecordedOutcome {
  outcome: DeliveryOutcome;
  nextAttemptAt: Date | null;
  /** True when this call actually moved the delivery. False when it recognised a
   * report it had already processed. */
  recorded: boolean;
  endpointId: string;
  environmentId: string;
  eventId: string;
  attempt: number;
  synthetic: boolean;
}

/** The identifiers, lifted off the locked row so both return paths agree. */
function identity(delivery: {
  endpointId: string;
  environmentId: string;
  eventId: string;
  attempt: number;
  synthetic: boolean;
}): Pick<
  RecordedOutcome,
  "endpointId" | "environmentId" | "eventId" | "attempt" | "synthetic"
> {
  return {
    endpointId: delivery.endpointId,
    environmentId: delivery.environmentId,
    eventId: delivery.eventId,
    attempt: delivery.attempt,
    synthetic: delivery.synthetic,
  };
}

export async function recordAttemptOutcome(
  db: Db,
  input: {
    deliveryId: string;
    attempt: number;
    status?: number;
    error?: string;
    /** How long the customer took to answer. Carried across the internal seam on
     * every attempt since chapter 3.5 and discarded until 3.6 wanted it (research
     * R6). Optional only so that callers written before it existed still compile;
     * every real caller has it. */
    latencyMs?: number;
  },
): Promise<RecordedOutcome> {
  return db.transaction(async (tx) => {
    const [delivery] = await tx
      .select({
        id: webhookDeliveries.id,
        environmentId: webhookDeliveries.environmentId,
        endpointId: webhookDeliveries.endpointId,
        eventId: webhookDeliveries.eventId,
        payload: webhookDeliveries.payload,
        attempt: webhookDeliveries.attempt,
        state: webhookDeliveries.state,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
        dispatchedAt: webhookDeliveries.dispatchedAt,
        synthetic: webhookDeliveries.synthetic,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, input.deliveryId))
      .for("update");

    if (!delivery) throw new DeliveryNotFoundError(input.deliveryId);

    // The idempotence check. A report for an attempt this delivery has already
    // moved past is a repeat: answer with what was decided the first time and
    // change nothing.
    if (delivery.state !== "pending" || delivery.attempt !== input.attempt) {
      return {
        outcome:
          delivery.state === "delivered"
            ? ("delivered" as const)
            : delivery.state === "dead"
              ? ("dead_lettered" as const)
              : ("rescheduled" as const),
        nextAttemptAt:
          delivery.state === "pending" ? delivery.nextAttemptAt : null,
        // NOT RECORDED. This branch changed no row, so nothing new happened and
        // the caller must not publish an attempt event for it (contract invariant
        // 1). The dispatcher posts, reports, then acknowledges, so a crash in the
        // last gap makes a second report ordinary rather than exceptional — and
        // nothing on the analytical path deduplicates, so publishing here would
        // put a retry that never happened on a customer's dashboard.
        recorded: false,
        ...identity(delivery),
      };
    }

    const succeeded =
      input.status !== undefined && input.status >= 200 && input.status < 300;

    // WHAT THE ENDPOINT SAID, kept on every recorded attempt whichever branch
    // follows. Two things need it and neither can get it from the attempt event,
    // whose publish is at-most-once by design: the test event answers a caller who
    // is waiting (FR-016), and the sweep names a disablement's last error at a
    // moment when no outcome is arriving (FR-009, research R1).
    const lastOutcome = {
      lastStatus: input.status ?? null,
      lastError: input.error ?? null,
      lastLatencyMs: input.latencyMs ?? null,
    };

    // THE FAILURE RUN, and a test event is exempt from it (contract invariant 13,
    // research R8). A test event is a diagnostic rather than traffic: letting a
    // failed test push an endpoint toward disablement would punish a customer for
    // checking, and letting a successful one CLEAR the run would let a customer
    // mask a real outage by testing until it passed. Both directions matter, which
    // is why the exemption is on the call and not inside it.
    if (!delivery.synthetic) {
      await applyFailureRun(tx, {
        endpointId: delivery.endpointId,
        failed: !succeeded,
        status: input.status ?? null,
        error: input.error ?? null,
      });
    }

    if (succeeded) {
      await tx
        .update(webhookDeliveries)
        .set({ state: "delivered", dispatchedAt: null, ...lastOutcome })
        .where(eq(webhookDeliveries.id, delivery.id));
      return {
        outcome: "delivered" as const,
        nextAttemptAt: null,
        recorded: true,
        ...identity(delivery),
      };
    }

    // A TEST EVENT GETS ONE ATTEMPT AND NO SCHEDULE (research R8, FR-013). A
    // caller is standing at their terminal waiting for the answer; a test that
    // quietly retried for two hours would report a stale one, and a test event
    // that kept coming back would be indistinguishable from real traffic to the
    // customer trying to read their logs.
    const next = delivery.synthetic ? null : nextAttemptAt(delivery.attempt + 1);
    if (next) {
      await tx
        .update(webhookDeliveries)
        .set({
          attempt: delivery.attempt + 1,
          nextAttemptAt: next,
          // Cleared so the relay can pick it up again when it falls due.
          dispatchedAt: null,
          ...lastOutcome,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      return {
        outcome: "rescheduled" as const,
        nextAttemptAt: next,
        recorded: true,
        ...identity(delivery),
      };
    }

    // Attempts exhausted. The dead letter and the state change commit together —
    // a delivery marked dead with no dead letter behind it would be a failure
    // with no record, which is exactly what FR-WHK-04's seven days are for.
    // …unless it was a test. A dead letter is a customer-visible record retained
    // for seven days and replayable (FR-WHK-04), and a test event is a diagnostic
    // the customer asked for and already has the answer to. Writing one would put
    // synthetic traffic in the store whose whole purpose is real traffic that
    // failed to leave, and offer an operator a "replay" button that re-sends a
    // test. The delivery is still marked dead, and the record of what happened is
    // the response the caller received plus `last_status` on the row.
    if (delivery.synthetic) {
      await tx
        .update(webhookDeliveries)
        .set({ state: "dead", dispatchedAt: null, ...lastOutcome })
        .where(eq(webhookDeliveries.id, delivery.id));
      return {
        outcome: "dead_lettered" as const,
        nextAttemptAt: null,
        recorded: true,
        ...identity(delivery),
      };
    }

    await tx.insert(webhookDeadLetters).values({
      id: randomUUID(),
      environmentId: delivery.environmentId,
      endpointId: delivery.endpointId,
      eventId: delivery.eventId,
      payload: delivery.payload,
      lastStatus: input.status ?? null,
      lastError: input.error ?? null,
      attempts: delivery.attempt,
    });
    await tx
      .update(webhookDeliveries)
      .set({ state: "dead", dispatchedAt: null, ...lastOutcome })
      .where(eq(webhookDeliveries.id, delivery.id));
    return {
      outcome: "dead_lettered" as const,
      nextAttemptAt: null,
      recorded: true,
      ...identity(delivery),
    };
  });
}

/** Create the one delivery a test event needs (chapter 3.6, FR-013, research R8).
 *
 * THREE DELIBERATE DEVIATIONS from `expandEventToDeliveries`, each with a reason,
 * and they are the whole difference between a test event and a real one:
 *
 *   * ONE ENDPOINT, named by the caller, rather than every endpoint whose
 *     subscription matches. A test is aimed. Fanning it out would send every other
 *     endpoint in the environment a surprise event they did not ask for.
 *   * DELIVERED EVEN WHEN DISABLED — `enabled` is not in the predicate below.
 *     Testing is how a customer establishes their endpoint is fixed BEFORE
 *     re-enabling it, and refusing here would make the disable-repair-re-enable
 *     loop unclosable, which is the whole point of FR-WHK-09.
 *   * NO CLAIM LEDGER. Expansion claims the event so a broker redelivery cannot
 *     double a customer's webhooks; nothing redelivers a test, because a person
 *     asked for it once over HTTP.
 *
 * Soft-deleted endpoints are still refused. A deleted endpoint is gone as far as
 * the customer's own API is concerned, and delivering to one would be the platform
 * reaching a url the customer believes it has forgotten.
 *
 * Everything else is ordinary: a real row, on the real schedule, delivered by the
 * real dispatcher, signed by the real signing path. That is FR-014 — a test whose
 * delivery worked differently would prove nothing about real deliveries. */
export async function createTestDelivery(
  db: Db,
  input: { endpointId: string; environmentId: string },
): Promise<{ deliveryId: string; eventId: string; payload: unknown } | null> {
  const [endpoint] = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, input.endpointId),
        eq(webhookEndpoints.environmentId, input.environmentId),
        isNull(webhookEndpoints.deletedAt),
      ),
    );
  if (!endpoint) return null;

  const eventId = randomUUID();
  // MARKED TWICE, for two different readers (FR-015). A recipient switching on
  // `type` and a recipient inspecting the body should each be able to tell this is
  // synthetic without knowing about the other — and neither should have to know
  // about `webhook_deliveries.synthetic`, which is the platform's own marker and
  // not part of the contract.
  const payload = {
    id: eventId,
    type: TEST_EVENT_TYPE,
    environment_id: input.environmentId,
    occurred_at: new Date().toISOString(),
    test: true,
    data: { message: "This is a test event from Relay." },
  };

  const deliveryId = randomUUID();
  await db.insert(webhookDeliveries).values({
    id: deliveryId,
    environmentId: input.environmentId,
    endpointId: endpoint.id,
    eventId,
    payload,
    // Due immediately: a caller is waiting.
    attempt: 1,
    synthetic: true,
  });

  return { deliveryId, eventId, payload };
}

/** What a test event's envelope calls itself. Exported because the contract names
 * it and a recipient may switch on it. */
export const TEST_EVENT_TYPE = "webhook.test";

/** What the endpoint answered, read back off the delivery the test created.
 *
 * The attempt happens in the DISPATCHER's process, so the route that is holding a
 * customer's request cannot observe it directly — it waits for the row to move.
 * `state` is the signal: `pending` means no outcome has been recorded yet. */
export async function testDeliveryResult(
  db: Db,
  deliveryId: string,
): Promise<{
  settled: boolean;
  delivered: boolean;
  status: number | null;
  error: string | null;
  latencyMs: number | null;
} | null> {
  const [row] = await db
    .select({
      state: webhookDeliveries.state,
      lastStatus: webhookDeliveries.lastStatus,
      lastError: webhookDeliveries.lastError,
      lastLatencyMs: webhookDeliveries.lastLatencyMs,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!row) return null;

  return {
    settled: row.state !== "pending",
    // A test event gets one attempt, so `delivered` and "the state is delivered"
    // are the same fact. Reading the state rather than the status keeps that
    // decision in one place — `recordAttemptOutcome` already decided what 2xx
    // means, and a second opinion here is a second thing to get wrong.
    delivered: row.state === "delivered",
    status: row.lastStatus,
    error: row.lastError,
    latencyMs: row.lastLatencyMs,
  };
}

/** Disable every endpoint whose failure run has outrun the hour (chapter 3.6,
 * research R1, contract invariant 12).
 *
 * THE SECOND TRIGGER, and it is not belt-and-braces. The on-outcome check catches
 * every endpoint that is still receiving attempts, and research R1 measured that
 * this is not all of them. Against chapter 3.5's tier table, one failing delivery
 * attempts at +35m36s and then not again until +2h35m36s — so nothing happens AT
 * the hour, and a check that only runs when an outcome is recorded fires
 * ninety-five minutes late. Worse: if that last attempt dead-letters and no
 * further events arrive for the environment, no outcome is ever recorded again and
 * the endpoint is never disabled at all. It sits enabled and failing for ever,
 * which is the state FR-WHK-07 exists to end.
 *
 * The endpoint that stays broken silently is the QUIET one — the low-traffic
 * customer, who is also the customer least likely to be watching.
 *
 * Rides the delivery relay's existing loop rather than adding a scheduler: one
 * more statement per drain, in a worker that is already awake and already holds a
 * connection (constitution VII). Its per-endpoint work goes through the same
 * `disableEndpoint` the on-outcome path uses, so the at-most-once rule is one rule
 * and not two implementations of it.
 *
 * Returns how many it disabled, so the relay can log a number rather than a claim.
 */
/*
 * THE FOUR CATEGORIES OF CROSS-ENVIRONMENT FUNCTION IN THIS FILE (feature 030). Three documents asserted there were five batch-taking functions; the
 * answer is four, and the reason the count kept slipping is that the third
 * category below has no home in a sentence about batch sizes:
 *
 *   1. TAKE A BATCH SIZE, and now all four REQUIRE one:
 *      drainOutbox, drainDueDeliveries, drainDisableNotifications,
 *      sweepDisabledEndpoints.
 *   2. RETURN A GLOBAL COUNT and have nothing to bound: outboxDepth,
 *      pendingDeliveryDepth. A count is one row; there is no batch to size. These
 *      are restricted from tests by lint instead — a global count(*)
 *      compared against itself is instance 4, twice in one file.
 *   3. CROSS ENVIRONMENTS BUT TAKE AN ID, so they are bounded by construction:
 *      recordAttemptOutcome, disableEndpoint. Nothing to require and nothing to
 *      restrict.
 *
 * Whoever adds the next cross-environment function reads this file, not the spec.
 */
export async function sweepDisabledEndpoints(
  db: Db,
  /** REQUIRED, as of feature 030 — the last of the four to carry a default.
   *
   * This would not have prevented instance 6 (research R8). The call that damaged
   * a neighbour's fixture was `sweepDisabledEndpoints(db)`, and
   * `sweepDisabledEndpoints(db, 10_000)` is worse rather than better: a bigger
   * batch reaches further into other people's rows. The required argument is a
   * prompt to think about WHOSE rows are in scope. The control is the trigger in
   * `packages/test-harness/src/sentinel.sql`, and a comment here claiming
   * otherwise would teach the wrong lesson. */
  limit: number,
): Promise<number> {
  // An INTERVAL built from the same constant the pure policy uses, so the sweep and
  // `shouldDisable` can never disagree about how long an hour is. Milliseconds
  // rather than a literal `'1 hour'`: one definition, in `disable.ts`.
  const disableCutoff = sql`now() - make_interval(secs => ${DISABLE_AFTER_MS / 1000})`;

  return db.transaction(async (tx) => {
    // The candidates, and the LAST THING each endpoint heard. `disableReason` and
    // the notification both want a status the sweep does not have in hand — it
    // fires precisely when no outcome is arriving — so it is read off the
    // endpoint's most recent attempted delivery. LEFT JOIN LATERAL, because an
    // endpoint whose deliveries have all been pruned still deserves to be switched
    // off; it just gets "no response" as its reason.
    //
    // `FOR UPDATE OF e SKIP LOCKED` is chapter 3.3's pattern and here it does two
    // jobs: it serialises the sweep against a concurrent outcome report on the same
    // endpoint, and it lets two api instances sweep at once without either waiting
    // — whichever skips simply finds nothing to do, which is correct.
    const candidates = (await tx.execute(sql`
      SELECT e.id,
             e.environment_id,
             e.failure_run_started_at AS run_started_at,
             e.failure_run_attempts   AS run_attempts,
             now()                    AS now,
             last.last_status,
             last.last_error
        FROM webhook_endpoints e
        LEFT JOIN LATERAL (
          SELECT d.last_status, d.last_error
            FROM webhook_deliveries d
           WHERE d.endpoint_id = e.id
             AND d.synthetic = false
             AND d.last_latency_ms IS NOT NULL
           ORDER BY d.next_attempt_at DESC, d.id DESC
           LIMIT 1
        ) last ON true
       WHERE e.enabled = true
         AND e.deleted_at IS NULL
         AND e.failure_run_started_at IS NOT NULL
         AND e.failure_run_attempts >= ${DISABLE_MIN_ATTEMPTS}
         AND e.failure_run_started_at < ${disableCutoff}
       ORDER BY e.failure_run_started_at
       LIMIT ${limit}
         FOR UPDATE OF e SKIP LOCKED`)) as unknown as {
      rows: {
        id: string;
        environment_id: string;
        run_started_at: string | Date;
        run_attempts: number;
        now: string | Date;
        last_status: number | null;
        last_error: string | null;
      }[];
    };

    let disabled = 0;
    for (const row of candidates.rows) {
      const result = await disableEndpoint(tx, {
        endpointId: row.id,
        environmentId: row.environment_id,
        // Same coercion, same reason as `applyFailureRun`'s clock read.
        runStartedAt: new Date(row.run_started_at),
        runAttempts: row.run_attempts,
        now: new Date(row.now),
        status: row.last_status,
        error: row.last_error,
      });
      if (result.disabled) disabled++;
    }
    return disabled;
  });
}

/** Everything the dispatcher needs to sign and post one delivery.
 *
 * Admin surface: one dispatcher serves every environment. The environment is
 * read from the DELIVERY rather than supplied by the caller, so this cannot be
 * pointed at a tenant by anyone who does not already hold a delivery id.
 *
 * Returns DECRYPTED secrets — one, or two inside a 24-hour rotation window. This
 * is the only place in the platform that hands a customer credential back in
 * plaintext, and the obligations that come with it are stated in
 * contracts/dispatcher.md rather than assumed. */
export async function deliveryMaterial(
  db: Db,
  deliveryId: string,
): Promise<{
  delivery_id: string;
  endpoint_id: string;
  environment_id: string;
  event_id: string;
  url: string;
  attempt: number;
  secrets: string[];
  payload: unknown;
} | null> {
  const [row] = await db
    .select({
      id: webhookDeliveries.id,
      environmentId: webhookDeliveries.environmentId,
      endpointId: webhookDeliveries.endpointId,
      eventId: webhookDeliveries.eventId,
      attempt: webhookDeliveries.attempt,
      payload: webhookDeliveries.payload,
      url: webhookEndpoints.url,
      enabled: webhookEndpoints.enabled,
      deletedAt: webhookEndpoints.deletedAt,
      synthetic: webhookDeliveries.synthetic,
      secretCiphertext: webhookEndpoints.secretCiphertext,
      secretPreviousCiphertext: webhookEndpoints.secretPreviousCiphertext,
      secretRotatedAt: webhookEndpoints.secretRotatedAt,
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookDeliveries.endpointId, webhookEndpoints.id),
    )
    .where(eq(webhookDeliveries.id, deliveryId));

  if (!row) return null;
  // An endpoint paused or removed after the delivery was scheduled gets nothing.
  // The spec's edge case: events already in the retry schedule for a removed
  // endpoint must not be delivered.
  //
  // A TEST EVENT IS THE EXCEPTION, and it is the only one (chapter 3.6, FR-013).
  // Two requirements meet exactly here and pull opposite ways: invariant 9 says a
  // disabled endpoint receives no attempts, and FR-013 says a customer may test a
  // disabled endpoint — which is how they establish it is fixed BEFORE re-enabling
  // it. `synthetic` is what tells them apart, and it is the reason that column is a
  // column rather than a string comparison against a customer-visible payload.
  //
  // DELETED IS STILL DELETED. A soft-deleted endpoint is gone as far as the
  // customer's own API is concerned, and delivering to one — test or not — would be
  // the platform reaching a url the customer believes it has forgotten.
  if (row.deletedAt) return null;
  if (!row.enabled && !row.synthetic) return null;

  return {
    delivery_id: row.id,
    endpoint_id: row.endpointId,
    environment_id: row.environmentId,
    event_id: row.eventId,
    url: row.url,
    attempt: row.attempt,
    secrets: activeSigningSecrets({
      secretCiphertext: row.secretCiphertext,
      secretPreviousCiphertext: row.secretPreviousCiphertext,
      secretRotatedAt: row.secretRotatedAt,
    }),
    payload: row.payload,
  };
}

/** A delivery that is due, as the relay claims it. */
export interface DueDeliveryRow {
  id: string;
  environment_id: string;
  endpoint_id: string;
  event_id: string;
  attempt: number;
}

/** Claim the deliveries that are due and hand each to `publish` — chapter 3.3's
 * `drainOutbox` with ONE MORE PREDICATE (research R13).
 *
 * That is the whole point, and it is worth not obscuring: the reader built this
 * loop two chapters ago. `SELECT … FOR UPDATE SKIP LOCKED`, publish, mark. The
 * only difference is `AND next_attempt_at <= now()`, and that difference is the
 * entire retry schedule.
 *
 * `SKIP LOCKED` matters here for the reason it mattered there: the api runs more
 * than once, so two relays draining one table is the ordinary deployment rather
 * than an edge case.
 *
 * NOTHING WAITS IN THE BROKER. A delivery enters the stream only once it is
 * already due — which is the property research R1 measured the alternative
 * against and found it wanting: a broker-held delay holds an acknowledgement
 * slot the whole time it waits, so dead endpoints starve healthy ones. */
export async function drainDueDeliveries(
  db: Db,
  limit: number,
  publish: (row: DueDeliveryRow) => Promise<void>,
): Promise<number> {
  return db.transaction(async (tx) => {
    const claimed = (await tx.execute(
      sql`SELECT id, environment_id, endpoint_id, event_id, attempt
            FROM webhook_deliveries
           WHERE state = 'pending'
             AND dispatched_at IS NULL
             AND next_attempt_at <= now()
           ORDER BY next_attempt_at, id
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED`,
    )) as unknown as { rows: DueDeliveryRow[] };

    const dispatched: string[] = [];
    try {
      for (const row of claimed.rows) {
        await publish(row);
        dispatched.push(row.id);
      }
    } finally {
      // In the `finally` for 3.3's reason: whatever went wrong with row N+1,
      // rows 1..N really did reach the broker and must not be published twice by
      // this instance's next pass.
      if (dispatched.length > 0) {
        await tx.execute(
          sql`UPDATE webhook_deliveries SET dispatched_at = now()
               WHERE id = ANY(${sql.raw(
                 `ARRAY[${dispatched.map((id) => `'${id}'`).join(",")}]::uuid[]`,
               )})`,
        );
      }
    }
    return dispatched.length;
  });
}

/** How many deliveries are waiting to become due. The number an operator watches
 * when a customer says "we stopped receiving webhooks". */
export async function pendingDeliveryDepth(db: Db): Promise<number> {
  const result = (await db.execute(
    sql`SELECT count(*)::int AS pending
          FROM webhook_deliveries
         WHERE state = 'pending'`,
  )) as unknown as { rows: { pending: number }[] };
  return result.rows[0]?.pending ?? 0;
}

/** Put a dead-lettered delivery back on the schedule.
 *
 * Resets the EXISTING delivery row rather than inserting a new one, and that is
 * forced by the shape of the data rather than chosen: `UNIQUE (event_id,
 * endpoint_id)` is what makes expansion idempotent, so a second row for the same
 * pair cannot exist. Reusing the row therefore preserves the original
 * `event_id` — the identifier the customer deduplicates on — by construction
 * instead of by remembering to copy it.
 *
 * **Current configuration, automatically.** The URL and the signing secrets are
 * read from the endpoint at SEND time by `deliveryMaterial`, never stored on the
 * delivery. So a replay of something that failed against a broken URL goes to
 * whatever the endpoint says today, which is the whole reason anyone asks for a
 * replay. Nothing here has to arrange that.
 *
 * **The dead-letter record is left alone.** FR-WHK-04 retains it for seven days,
 * and a replay is a new attempt rather than an erasure of the fact that the
 * attempts once ran out. Deleting it would remove the only evidence a customer's
 * endpoint was broken at the moment somebody retried it.
 *
 * Returns false when there is no such dead letter — the controller's 404. */
export async function replayDeadLetter(
  db: Db,
  deadLetterId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [dead] = await tx
      .select({
        eventId: webhookDeadLetters.eventId,
        endpointId: webhookDeadLetters.endpointId,
      })
      .from(webhookDeadLetters)
      .where(eq(webhookDeadLetters.id, deadLetterId));
    if (!dead) return false;

    await tx
      .update(webhookDeliveries)
      .set({
        state: "pending",
        // Tier 1: a replay is a fresh chance, not a continuation of a schedule
        // that has already run out.
        attempt: 1,
        nextAttemptAt: new Date(),
        dispatchedAt: null,
      })
      .where(
        and(
          eq(webhookDeliveries.eventId, dead.eventId),
          eq(webhookDeliveries.endpointId, dead.endpointId),
        ),
      );
    return true;
  });
}

export async function outboxDepth(db: Db): Promise<number> {
  const result = (await db.execute(
    sql`SELECT count(*)::int AS pending FROM outbox WHERE published_at IS NULL`,
  )) as unknown as { rows: { pending: number }[] };
  return result.rows[0]?.pending ?? 0;
}

// ---------------------------------------------------------------------------
// The consumer's deduplication ledger (chapter 3.4, SAD risk R5). Admin surface
// for the same reason the outbox drain is: it runs on behalf of the platform
// rather than of a tenant, and one consumer reads every environment's events.
// ---------------------------------------------------------------------------

/** What happened when a consumer tried to take an event. */
export type ClaimResult = "handled" | "duplicate";

/** Claim an event for a consumer and run its effect — **in one transaction**.
 *
 * This is the shape chapter 3.3 used for the outbox row and the message it
 * describes, pointed the other way: the ledger row and the effect share a fate.
 * A handler that throws rolls the claim back with it, so the redelivery finds no
 * claim and runs again. Claiming outside the transaction would mean a failed
 * handler leaves a claim behind, and the redelivery would be waved through as a
 * duplicate — an event silently never handled, which is worse than one handled
 * twice.
 *
 * The INSERT is the check. `ON CONFLICT DO NOTHING` with a `RETURNING` tells us
 * whether this call won the row; a SELECT-then-INSERT would let two instances
 * fetching the same message both believe they were first (2.3's lesson on
 * idempotency keys, 3.1's on signup).
 *
 * **The limit of this, stated because chapter 3.5 will meet it**: the effect has
 * to be transactional for the fate to be shared, which means it has to be in
 * Postgres. A handler whose effect is an HTTP call to a customer cannot be
 * rolled back, and no ledger makes it so. That consumer must choose which way to
 * be wrong, and choosing is its chapter's work.
 */
export async function claimEvent(
  db: Db,
  consumer: string,
  eventId: string,
  effect: () => Promise<void>,
): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(consumedEvents)
      .values({ consumer, eventId })
      .onConflictDoNothing({
        target: [consumedEvents.consumer, consumedEvents.eventId],
      })
      .returning({ eventId: consumedEvents.eventId });

    if (claimed.length === 0) return "duplicate";
    await effect();
    return "handled";
  });
}

/** How many times a consumer has handled a given event. Zero or one, always —
 * which is the assertion the redelivery test makes, and the reason this exists
 * rather than the test reaching into the table itself. */
export async function timesHandled(
  db: Db,
  consumer: string,
  eventId: string,
): Promise<number> {
  const rows = await db
    .select({ eventId: consumedEvents.eventId })
    .from(consumedEvents)
    .where(
      and(
        eq(consumedEvents.consumer, consumer),
        eq(consumedEvents.eventId, eventId),
      ),
    );
  return rows.length;
}

/** What a signup produced — or found. `created` answers "was an organisation
 * created on this call?", NOT "was the identity new": a known human who owned
 * nothing gets `created: true`, because one really was created for them. */
export interface Provisioned {
  organisation: { id: string; name: string };
  application: { id: string; name: string };
  environment: { id: string; kind: Environment["kind"] };
  human: { id: string; provider: string; provider_account_id: string };
  created: boolean;
  /** Chapter 3.2, research R8: the environment's FIRST key, present only when
   * this call created the tenant. With no console session, nothing else can
   * bootstrap a credential — a brand-new organisation cannot authenticate a
   * request to ask for one. A returning owner gets no key, because the old
   * secret is unrecoverable and the answer to a lost secret is rotation. */
  apiKey?: { prefix: string; secret: string };
}

/** Signup (chapter 3.1, FR-TEN-01/02). The admin surface's second entrance:
 * it mints a tenant, so like createEnvironment it carries no tenant scope —
 * it is the operation that creates one.
 *
 * ATOMIC: one transaction. A half-built tenant — an application with no
 * environment — is unusable and invisible to the person who just signed up,
 * so there is no state between "nothing" and "everything".
 *
 * IDEMPOTENT ON THE OWNED ORGANISATION, which is the only rule that is defined
 * for every reachable case:
 *
 *   unknown identity           -> five rows; created: true
 *   known, owns an org         -> that org; nothing written; created: false
 *   known, owns none           -> four rows (no new human); created: true
 *
 * The third case cannot happen until invitations exist, and the rule is stated
 * now because "return the existing organisation" is undefined for a human who
 * only belongs to someone ELSE's — a state FR-TEN-07 makes legal the moment
 * membership management arrives. Signing up gives you your own workspace; it
 * never hands you somebody else's.
 */
export async function provisionOrganisation(
  db: Db,
  {
    provider,
    providerAccountId,
    displayName,
    email,
    organisationName,
  }: {
    provider: string;
    providerAccountId: string;
    displayName?: string | null;
    email?: string | null;
    organisationName: string;
  },
): Promise<Provisioned> {
  return db.transaction(async (tx) => {
    // The identity, or the row that already speaks for it. The unique index on
    // (provider, provider_account_id) is what decides under concurrency — a
    // read-then-write check here would let two simultaneous first clicks both
    // believe they were first (2.3's lesson, on a different table).
    const [existingHuman] = await tx
      .select({
        id: humans.id,
        provider: humans.provider,
        provider_account_id: humans.providerAccountId,
      })
      .from(humans)
      .where(
        and(
          eq(humans.provider, provider),
          eq(humans.providerAccountId, providerAccountId),
        ),
      );

    if (existingHuman) {
      // Does this identity already OWN an organisation? Membership is not
      // ownership: being a member of someone else's does not count.
      const [owned] = await tx
        .select({
          id: organisations.id,
          name: organisations.name,
        })
        .from(memberships)
        .innerJoin(
          organisations,
          eq(organisations.id, memberships.organisationId),
        )
        .where(
          and(
            eq(memberships.humanId, existingHuman.id),
            eq(memberships.role, "owner"),
          ),
        )
        .orderBy(asc(memberships.joinedAt))
        .limit(1);

      if (owned) {
        const [application] = await tx
          .select({ id: applications.id, name: applications.name })
          .from(applications)
          .where(eq(applications.organisationId, owned.id))
          .orderBy(asc(applications.createdAt))
          .limit(1);
        const [environment] = await tx
          .select({
            id: environments.id,
            kind: sql<Environment["kind"]>`${environments.kind}`,
          })
          .from(environments)
          .where(eq(environments.applicationId, application!.id))
          .orderBy(asc(environments.kind))
          .limit(1);
        return {
          organisation: owned,
          application: application!,
          environment: environment!,
          human: existingHuman,
          created: false,
        };
      }
    }

    const human =
      existingHuman ??
      (
        await tx
          .insert(humans)
          .values({
            id: randomUUID(),
            provider,
            providerAccountId,
            displayName: displayName ?? null,
            email: email ?? null,
          })
          .returning({
            id: humans.id,
            provider: humans.provider,
            provider_account_id: humans.providerAccountId,
          })
      )[0]!;

    const organisationId = randomUUID();
    const applicationId = randomUUID();
    const environmentId = randomUUID();

    await tx
      .insert(organisations)
      .values({ id: organisationId, name: organisationName });
    await tx.insert(applications).values({
      id: applicationId,
      organisationId,
      name: organisationName,
    });
    await tx.insert(environments).values({
      id: environmentId,
      applicationId,
      // FR-TEN-02: development, and only development. The production
      // environment is possible (FR-TEN-04) but not automatic.
      kind: "development",
      signingSecret: randomUUID(),
    });
    await tx.insert(memberships).values({
      organisationId,
      humanId: human.id,
      role: "owner", // FR-TEN-07's vocabulary; management of it is later
    });

    // The first credential, inside the same transaction as the tenant it
    // belongs to (chapter 3.2). A key written outside this transaction could
    // outlive a rolled-back organisation and authenticate against nothing.
    // FR-DSH-01 wants a development key on the first screen after signup; this
    // is where it comes from.
    const key = await createApiKey(tx, { environmentId });

    return {
      organisation: { id: organisationId, name: organisationName },
      application: { id: applicationId, name: organisationName },
      environment: { id: environmentId, kind: "development" as const },
      human,
      created: true,
      apiKey: { prefix: key.prefix, secret: key.credential },
    };
  });
}

export interface UserRow {
  id: string;
  external_id: string;
  display_name: string | null;
}

export interface ChannelRow {
  id: string;
  external_id: string;
  type: "public" | "private";
  name: string | null;
}

export interface MessageRow {
  id: string;
  channel_id: string;
  seq: number;
  text: string | null;
  created_at: string;
  /** Chapter 2.3 (FR-MSG-04): true when a retry was recognised by the
   * idempotency index and the ORIGINAL message was returned instead of
   * a new insert. The service layer uses this to decide response shape. */
  duplicate?: boolean;
}

/** A message as the READ paths return it (chapter 2.7). The sender is the
 * external id — the identifier a client knows — and it is nullable for two
 * honest reasons: the column has been nullable since 2.1 (system messages
 * have no author), and every row written through the socket before 2.6's
 * fix has no author recorded. A caller that needs to build a wire frame
 * has to decide what to do with those; the layer does not decide for it. */
export interface MessageWithSender extends MessageRow {
  user: string | null;
}

/** Thrown when a channel id resolves to nothing IN THIS TENANT — which,
 * from the caller's side, is indistinguishable from "does not exist"
 * (FR-TEN-05: no data, and no reveal that the foreign id exists). The
 * layer stays framework-free; the service turns this into the wire's
 * 404 (constitution I's isolation, EIR-API-04's envelope). */
export class ChannelNotFoundError extends Error {
  constructor(public readonly channelId: string) {
    super(`channel not found: ${channelId}`);
    this.name = "ChannelNotFoundError";
  }
}

/** Timestamps cross the wire as RFC 3339 strings (constitution: UTC,
 * millisecond precision) — the driver hands back a Date or a string
 * depending on the column and the query shape. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** A webhook endpoint as the management surface returns it. The ciphertext is
 * absent by construction rather than by filtering — a read path that can return
 * it is one refactor away from a response that does. */
export interface WebhookEndpointRow {
  id: string;
  url: string;
  event_types: string[];
  enabled: boolean;
  secret_rotated_at: string | null;
  created_at: string;
  /** Chapter 3.6, FR-009. `enabled: false` with `disabled_at: null` means the
   * customer paused it themselves; both set means the platform did. Without this
   * pair a customer looking at a disabled endpoint has no way to tell whether they
   * are looking at their own decision or ours, and the support conversation starts
   * from zero. */
  disabled_at: string | null;
  disabled_reason: string | null;
  /** The run as it stands, so a customer can see a disablement COMING rather than
   * only after it lands. Both null when the endpoint is healthy. */
  failure_run_started_at: string | null;
  failure_run_attempts: number | null;
}

/** Raised when an outcome names a delivery that is not there. A caller error,
 * not a platform one — the controller turns it into a 404. */
export class DeliveryNotFoundError extends Error {
  constructor(id: string) {
    super(`no such delivery: ${id}`);
    this.name = "DeliveryNotFoundError";
  }
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  attempt: number;
  state: string;
  next_attempt_at: string;
  /** Non-null once the relay has published it. Exposed because the drain is
   * GLOBAL — one dispatcher serves every environment — so a test that asserts on
   * what ITS call to the drain returned is asserting on which suite got there
   * first. Chapter 3.3's finding 3, in its third chapter. */
  dispatched_at: string | null;
}

export interface WebhookDeadLetterRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  last_status: number | null;
  last_error: string | null;
  attempts: number;
  dead_lettered_at: string;
}

export class Repository {
  // Constructor parameter properties — the shorthand chapter 1.4 released
  // for this service when ADR-15 spent erasableSyntaxOnly on decorator
  // metadata. The guarantee still holds in the gateway and every package.
  constructor(
    private readonly db: Db,
    private readonly environmentId: string,
  ) {}

  /** The tenant this repository is scoped to, readable but not settable.
   *
   * Added in chapter 3.6 for the test event, which needs an UNSCOPED operation —
   * `createTestDelivery` ignores subscriptions and `enabled`, so it cannot be a
   * method here — but must still be told which environment is asking. Exposing the
   * id rather than widening the operation keeps constitution I's shape: the
   * environment still comes from a verified principal, never from a request body.
   */
  get environment(): string {
    return this.environmentId;
  }

  // ---------------------------------------------------------------------
  // Webhook endpoints (chapter 3.5). Scoped like everything else on this class:
  // the environment comes from the constructor and never from a caller, so a
  // handler cannot ask for another tenant's endpoints even by accident
  // (constitution I).
  //
  // Every read here excludes soft-deleted rows. That is the whole contract of
  // `deleted_at`: the row survives so its dead letters can, and it is invisible
  // to everything else.
  // ---------------------------------------------------------------------

  private get liveEndpoints() {
    return and(
      eq(webhookEndpoints.environmentId, this.environmentId),
      isNull(webhookEndpoints.deletedAt),
    );
  }

  async countEndpoints(): Promise<number> {
    const rows = await this.db
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(this.liveEndpoints);
    return rows.length;
  }

  async createEndpoint(input: {
    url: string;
    eventTypes: string[];
    secretCiphertext: string;
  }): Promise<WebhookEndpointRow> {
    const id = randomUUID();
    await this.db.insert(webhookEndpoints).values({
      id,
      environmentId: this.environmentId,
      url: input.url,
      eventTypes: input.eventTypes,
      secretCiphertext: input.secretCiphertext,
    });
    const row = await this.getEndpoint(id);
    if (!row) throw new Error("endpoint vanished immediately after insert");
    return row;
  }

  async listEndpoints(): Promise<WebhookEndpointRow[]> {
    return this.selectEndpoints(this.liveEndpoints);
  }

  async getEndpoint(id: string): Promise<WebhookEndpointRow | null> {
    const rows = await this.selectEndpoints(
      and(eq(webhookEndpoints.id, id), this.liveEndpoints),
    );
    return rows[0] ?? null;
  }

  /** Opens a 24-hour rotation window: the outgoing secret keeps signing until it
   * closes, so a recipient accepting either is correct throughout
   * (contracts/webhooks.md §Rotation). */
  async rotateEndpointSecret(
    id: string,
    secretCiphertext: string,
  ): Promise<WebhookEndpointRow | null> {
    const current = await this.getEndpoint(id);
    if (!current) return null;
    const [previous] = await this.db
      .select({ secretCiphertext: webhookEndpoints.secretCiphertext })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), this.liveEndpoints));
    await this.db
      .update(webhookEndpoints)
      .set({
        secretCiphertext,
        secretPreviousCiphertext: previous?.secretCiphertext ?? null,
        secretRotatedAt: new Date(),
      })
      .where(and(eq(webhookEndpoints.id, id), this.liveEndpoints));
    return this.getEndpoint(id);
  }

  async setEndpointEnabled(
    id: string,
    enabled: boolean,
  ): Promise<WebhookEndpointRow | null> {
    await this.db
      .update(webhookEndpoints)
      .set({
        enabled,
        // RE-ENABLING CLEARS THE RUN, all four columns, in this one statement
        // (chapter 3.6, FR-017). The hour is measured from the NEXT failure, not
        // resumed from the old one — otherwise a customer who fixed their server
        // and switched it back on would be disabled again by the first failure
        // after that, on the strength of an outage they had already repaired.
        //
        // `disabled_at` and `disabled_reason` go too, because FR-009 reads them as
        // "the platform switched this off" and after a re-enable that is no longer
        // true. A schema CHECK requires those two to agree, so they must move
        // together whatever else happens here.
        //
        // DISABLING clears nothing. A customer pausing their own endpoint has said
        // nothing about whether it is healthy, and throwing away the run would let
        // a disable/enable cycle launder an hour of failures.
        ...(enabled
          ? {
              failureRunStartedAt: null,
              failureRunAttempts: null,
              disabledAt: null,
              disabledReason: null,
            }
          : {}),
      })
      .where(and(eq(webhookEndpoints.id, id), this.liveEndpoints));
    return this.getEndpoint(id);
  }

  /** SOFT. A hard delete would have to cascade, and cascading would erase the
   * customer's dead letters — which FR-WHK-04 says to retain for seven days.
   * Returns false when there was nothing live to delete, which the controller
   * turns into the same 404 a foreign tenant gets. */
  async deleteEndpoint(id: string): Promise<boolean> {
    const existing = await this.getEndpoint(id);
    if (!existing) return false;
    await this.db
      .update(webhookEndpoints)
      .set({ deletedAt: new Date() })
      .where(and(eq(webhookEndpoints.id, id), this.liveEndpoints));
    return true;
  }

  /** Every delivery this event produced, for this environment. Scoped like
   * everything else on this class — the drain is global, but a tenant's view of
   * its own deliveries is not. */
  async listDeliveriesForEvent(eventId: string): Promise<WebhookDeliveryRow[]> {
    const rows = await this.db
      .select({
        id: webhookDeliveries.id,
        endpointId: webhookDeliveries.endpointId,
        eventId: webhookDeliveries.eventId,
        attempt: webhookDeliveries.attempt,
        state: webhookDeliveries.state,
        nextAttemptAt: webhookDeliveries.nextAttemptAt,
        dispatchedAt: webhookDeliveries.dispatchedAt,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.environmentId, this.environmentId),
          eq(webhookDeliveries.eventId, eventId),
        ),
      )
      .orderBy(asc(webhookDeliveries.id));
    return rows.map((r) => ({
      id: r.id,
      endpoint_id: r.endpointId,
      event_id: r.eventId,
      attempt: r.attempt,
      state: r.state,
      next_attempt_at: r.nextAttemptAt.toISOString(),
      dispatched_at: r.dispatchedAt?.toISOString() ?? null,
    }));
  }

  /** A tenant's dead letters, newest first. Scoped: a dead letter holds a
   * payload that was being sent to this customer, which is why the table carries
   * `environment_id` where 3.3's outbox and 3.4's ledger did not. */
  async listDeadLetters(): Promise<WebhookDeadLetterRow[]> {
    const rows = await this.db
      .select({
        id: webhookDeadLetters.id,
        endpointId: webhookDeadLetters.endpointId,
        eventId: webhookDeadLetters.eventId,
        lastStatus: webhookDeadLetters.lastStatus,
        lastError: webhookDeadLetters.lastError,
        attempts: webhookDeadLetters.attempts,
        deadLetteredAt: webhookDeadLetters.deadLetteredAt,
      })
      .from(webhookDeadLetters)
      .where(eq(webhookDeadLetters.environmentId, this.environmentId))
      .orderBy(desc(webhookDeadLetters.deadLetteredAt));
    return rows.map((r) => ({
      id: r.id,
      endpoint_id: r.endpointId,
      event_id: r.eventId,
      last_status: r.lastStatus,
      last_error: r.lastError,
      attempts: r.attempts,
      dead_lettered_at: r.deadLetteredAt.toISOString(),
    }));
  }

  private async selectEndpoints(
    where: ReturnType<typeof and>,
  ): Promise<WebhookEndpointRow[]> {
    const rows = await this.db
      .select({
        id: webhookEndpoints.id,
        url: webhookEndpoints.url,
        eventTypes: webhookEndpoints.eventTypes,
        enabled: webhookEndpoints.enabled,
        secretRotatedAt: webhookEndpoints.secretRotatedAt,
        createdAt: webhookEndpoints.createdAt,
        disabledAt: webhookEndpoints.disabledAt,
        disabledReason: webhookEndpoints.disabledReason,
        failureRunStartedAt: webhookEndpoints.failureRunStartedAt,
        failureRunAttempts: webhookEndpoints.failureRunAttempts,
      })
      .from(webhookEndpoints)
      .where(where);
    // Never the ciphertext. A read path that can return it is one refactor away
    // from a response that does.
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      event_types: r.eventTypes as string[],
      enabled: r.enabled,
      secret_rotated_at: r.secretRotatedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
      disabled_at: r.disabledAt?.toISOString() ?? null,
      disabled_reason: r.disabledReason,
      failure_run_started_at: r.failureRunStartedAt?.toISOString() ?? null,
      failure_run_attempts: r.failureRunAttempts,
    }));
  }

  async createUser(externalId: string, displayName?: string): Promise<UserRow> {
    const id = randomUUID();
    await this.db.insert(users).values({
      id,
      environmentId: this.environmentId,
      externalId,
      displayName: displayName ?? null,
    });
    return { id, external_id: externalId, display_name: displayName ?? null };
  }

  async getUserByExternalId(externalId: string): Promise<UserRow | null> {
    const rows = await this.db
      .select({
        id: users.id,
        external_id: users.externalId,
        display_name: users.displayName,
      })
      .from(users)
      .where(
        and(
          eq(users.environmentId, this.environmentId),
          eq(users.externalId, externalId),
        ),
      );
    return rows[0] ?? null;
  }

  async createChannel(
    externalId: string,
    type: ChannelRow["type"],
    name?: string,
  ): Promise<ChannelRow> {
    const id = randomUUID();
    await this.db.insert(channels).values({
      id,
      environmentId: this.environmentId,
      externalId,
      type,
      name: name ?? null,
    });
    return { id, external_id: externalId, type, name: name ?? null };
  }

  async getChannelByExternalId(externalId: string): Promise<ChannelRow | null> {
    const rows = await this.db
      .select({
        id: channels.id,
        external_id: channels.externalId,
        type: sql<ChannelRow["type"]>`${channels.type}`,
        name: channels.name,
      })
      .from(channels)
      .where(
        and(
          eq(channels.environmentId, this.environmentId),
          eq(channels.externalId, externalId),
        ),
      );
    return rows[0] ?? null;
  }

  async listChannels(): Promise<ChannelRow[]> {
    return this.db
      .select({
        id: channels.id,
        external_id: channels.externalId,
        type: sql<ChannelRow["type"]>`${channels.type}`,
        name: channels.name,
      })
      .from(channels)
      .where(eq(channels.environmentId, this.environmentId))
      .orderBy(asc(channels.externalId));
  }

  /** Membership joins live in channel-land, so the tenant scope rides the
   * channel: the double-scoped SELECT below is what makes a foreign channel
   * id useless. INSERT ... SELECT is where the builder falls short — this
   * is the layer's one raw SQL island, permitted by ADR-16 and kept inside
   * the wall like everything else. */
  async addMember(channelId: string, userId: string): Promise<boolean> {
    const result = await this.db.execute(
      sql`INSERT INTO members (channel_id, user_id)
          SELECT c.id, u.id FROM channels c, users u
          WHERE c.id = ${channelId} AND c.environment_id = ${this.environmentId}
            AND u.id = ${userId} AND u.environment_id = ${this.environmentId}`,
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listMembers(channelId: string): Promise<string[]> {
    const rows = await this.db
      .select({ user_id: members.userId })
      .from(members)
      .innerJoin(channels, eq(channels.id, members.channelId))
      .where(
        and(
          eq(members.channelId, channelId),
          eq(channels.environmentId, this.environmentId),
        ),
      )
      .orderBy(asc(members.joinedAt));
    return rows.map((r) => r.user_id);
  }

  async channelsForUser(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ channel_id: members.channelId })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(
        and(
          eq(members.userId, userId),
          eq(users.environmentId, this.environmentId),
        ),
      );
    return rows.map((r) => r.channel_id);
  }

  /** The write path (chapters 2.2 + 2.3): sequence assignment under the
   * channel row lock (ADR-03), with idempotency enforcement via the
   * partial unique index (DR-03). The transaction IS the ordering
   * guarantee: the lock serialises assignment per channel, and the ack
   * that matters happens only after commit (FR-MSG-05).
   *
   * When an idempotency key is present and conflicts with an existing
   * message, the insert is skipped (ON CONFLICT DO NOTHING), the channel's
   * sequence is left untouched, and the ORIGINAL message is returned with
   * `duplicate: true` — FR-MSG-04's "201-equivalent semantics".
   */
  async sendMessage(
    channelId: string,
    {
      userId,
      userExternalId,
      text,
      metadata,
      idempotencyKey,
    }: {
      userId?: string;
      /** Chapter 3.3: the sender as a CONSUMER will see them. Threaded from the
       * caller rather than looked up here — the internal route already holds it
       * (it is the token's subject), and an extra SELECT inside the write
       * transaction is a cost every message would pay forever. Absent on the
       * public REST route, where a key-authenticated send is unattributed. */
      userExternalId?: string;
      text: string;
      metadata?: unknown;
      idempotencyKey?: string;
    },
  ): Promise<MessageRow> {
    return this.db.transaction(async (tx) => {
      // ONE PERIOD FOR THE WHOLE TRANSACTION, taken before anything is checked.
      // The cap check and the increment must agree about which month this is; a
      // send that checked August and incremented September would be refused
      // against one number and counted against another. The app clock rather
      // than the database's, because both statements need the same value and
      // only one of them can be `now()`.
      const period = periodOf(new Date());

      const [channel] = await tx
        .select({ id: channels.id, lastSequence: channels.lastSequence })
        .from(channels)
        .where(
          and(
            eq(channels.id, channelId),
            eq(channels.environmentId, this.environmentId),
          ),
        )
        .for("update");
      if (!channel) throw new ChannelNotFoundError(channelId);

      // THE CAP, CHECKED BEFORE THE MESSAGE IS WRITTEN (chapter 3.10, FR-007).
      //
      // Here rather than in middleware, because chapter 3.8's limiter never sees
      // `/internal/messages` — `operationsFor` returns [] for anything outside
      // `/v1` — and that is the route a WebSocket send arrives on. Both doors
      // reach this method, and it already owns the write transaction, so the
      // check and the increment commit together (research R3).
      //
      // A PLAIN READ, AND THE OVERSHOOT IS STATED RATHER THAN DEFENDED AGAINST.
      //
      // The first version took `FOR UPDATE` on the usage row, which bounds the
      // overshoot to exactly one message. Two things retired it.
      //
      // The caps and the usage are now ONE joined read, and Postgres will not
      // lock that:
      //
      //   ERROR:  FOR UPDATE cannot be applied to the nullable side of an outer join
      //
      // And the specification never asked for the lock. Its edge case reads: "the
      // overshoot is bounded by concurrency, not unbounded, and this is stated
      // rather than defended against." A few dozen sends in flight against a
      // monthly cap of thousands is a bound worth naming rather than engineering
      // around.
      //
      // WHAT THE QUOTA PATH COSTS, measured with the phases instrumented and the
      // config toggled on one environment: 0.56ms per send at 32-way concurrency.
      // The joined read is about 1.2ms of that and US1 needs it whether or not a
      // cap exists. An earlier uncontrolled benchmark reported 273% and sent three
      // separate hypotheses chasing what turned out to be warm-up (T033).
      const quota = await this.assertWithinQuota(tx, period, userId);

      const seq = channel.lastSequence + 1;
      const id = randomUUID();

      const insert = tx.insert(messages).values({
        id,
        channelId: channel.id,
        sequence: seq,
        userId: userId ?? null,
        text,
        metadata: metadata ?? {},
        idempotencyKey: idempotencyKey ?? null,
      });

      // The conflict clause is attached ONLY when a key is present, and it
      // names the partial index explicitly. A bare ON CONFLICT DO NOTHING
      // would absorb every constraint on the table — including DR-01's
      // UNIQUE (channel_id, sequence), whose loud failure is 2.2's safety
      // net. A keyless send therefore carries no conflict clause at all.
      const inserted = await (
        idempotencyKey
          ? insert.onConflictDoNothing({
              target: [messages.channelId, messages.idempotencyKey],
              where: sql`${messages.idempotencyKey} IS NOT NULL`,
            })
          : insert
      ).returning({ id: messages.id, createdAt: messages.createdAt });

      if (inserted.length === 0) {
        // The key has been here before. Return the ORIGINAL message — the
        // retry gets the same answer the lost ack carried (FR-MSG-04) —
        // and leave last_sequence alone: a recognised duplicate wrote
        // nothing, so it consumes nothing.
        return {
          ...(await this.getMessageByIdempotencyKey(
            tx,
            channel.id,
            idempotencyKey!,
          )),
          duplicate: true,
        };
      }

      // The sequence is spent only by a message that actually landed.
      await tx
        .update(channels)
        .set({ lastSequence: seq })
        .where(eq(channels.id, channel.id));

      const createdAt = toIso(inserted[0]!.createdAt);

      // THE EVENT COMMITS WITH THE MESSAGE (chapter 3.3, ADR-06).
      //
      // This insert is inside the transaction that already guards the write, so
      // the two share a fate: no message without its event, no event without
      // its message. Publishing after the commit instead would leave a gap —
      // crash in it and the message exists while the event never did, silently,
      // with nothing to reconcile against.
      //
      // It sits on the INSERTED branch only. A recognised idempotent retry
      // returned above without writing anything and must consume no event
      // either, or a client retrying on a flaky link fires a second webhook for
      // one message (FR-MSG-04, research R1).
      //
      // The envelope is built complete here and never touched again: the relay
      // moves bytes, it does not author them (ADR-04).
      const event = messageCreatedEvent({
        eventId: randomUUID(),
        environmentId: this.environmentId,
        message: {
          id,
          channel_id: channel.id,
          seq,
          user: userExternalId ?? null,
          text,
          created_at: createdAt,
        },
      });
      await tx.insert(outbox).values({
        subject: event.subject,
        payload: event.payload,
      });

      // THE MONTH'S USAGE COMMITS WITH THE MESSAGE (chapter 3.10, FR-RTL-05).
      //
      // Same argument as the event above it, one requirement further on. A quota
      // is about THIS MONTH and must not forget, so the count cannot live in the
      // per-minute counter store chapter 3.8 built — a flush there costs one
      // window of over-service, a flush here costs the month (FR-002).
      //
      // It is an increment rather than a query because the alternative is a read
      // over `messages`, which carries no `environment_id` and no index on
      // `created_at`: the month predicate becomes a Filter applied after every
      // row the tenant has ever sent is read off the heap. Fast today, and
      // proportional to lifetime traffic forever (research R1).
      //
      // On the INSERTED branch only, like the event. A recognised idempotent
      // retry wrote no message and must consume no quota either, or a client
      // retrying on a flaky link is billed twice for one message.
      await tx
        .insert(usagePeriods)
        .values({ environmentId: this.environmentId, period, messagesSent: 1 })
        .onConflictDoUpdate({
          target: [usagePeriods.environmentId, usagePeriods.period],
          set: { messagesSent: sql`${usagePeriods.messagesSent} + 1` },
        });

      // The distinct-user count, and the reason it is a row rather than a
      // counter: incrementing it would need to know whether this user already
      // sent this period, which is a read. The row IS the answer, and
      // `ON CONFLICT DO NOTHING` makes the second send of the month free.
      //
      // ONLY WHEN THE SEND IS ATTRIBUTED. A key-authenticated REST send carries
      // no `userId` — unattributed by design since chapter 3.3 — and counts
      // toward the message quota and toward no user.
      if (userId !== undefined) {
        await tx
          .insert(usageActiveUsers)
          .values({ environmentId: this.environmentId, period, userId })
          .onConflictDoNothing();
      }

      // What this send crossed, if anything. Almost always nothing, which is why
      // the caps are read first and the whole block skipped when none is set.
      // WORK OUT WHETHER ANYTHING WAS CROSSED BEFORE ASKING THE DATABASE ANYTHING.
      //
      // `thresholdsCrossed` is pure arithmetic on two numbers the transaction
      // already holds, and it answers "nothing" for almost every send. The first
      // version looked up the organisation and counted the period's users FIRST
      // and consulted the arithmetic afterwards, which put two extra queries on
      // every send by an environment that merely HAS a quota — measured at 341%
      // over the unconfigured path and mistaken, at first, for the cost of a lock
      // (T033).
      if (quota) {
        const messageRef =
          quota.caps.messages.hard ?? quota.caps.messages.soft;
        const crossedMessages = thresholdsCrossed(
          quota.sent,
          quota.sent + 1,
          messageRef,
        );
        // The user count is only worth asking for when a user cap exists AND this
        // send could have added someone.
        const userRef =
          quota.caps.active_users.hard ?? quota.caps.active_users.soft;
        const mayHaveAddedUser = userId !== undefined && userRef !== null;

        if (crossedMessages.length > 0 || mayHaveAddedUser) {
          const organisationId = await this.organisationOf(tx);
          if (organisationId) {
            if (crossedMessages.length > 0) {
              await this.recordCrossings(
                tx,
                period,
                "messages",
                quota.sent,
                quota.sent + 1,
                quota.caps.messages,
                organisationId,
              );
            }
            if (mayHaveAddedUser) {
              const [n] = await tx
                .select({ n: sql<number>`count(*)::int` })
                .from(usageActiveUsers)
                .where(
                  and(
                    eq(usageActiveUsers.environmentId, this.environmentId),
                    eq(usageActiveUsers.period, period),
                  ),
                );
              const users = n?.n ?? 0;
              await this.recordCrossings(
                tx,
                period,
                "active_users",
                users - 1,
                users,
                quota.caps.active_users,
                organisationId,
              );
            }
          }
        }
      }

      return {
        id,
        channel_id: channel.id,
        seq,
        text,
        created_at: createdAt,
      };
    });
  }

  /** Refuse the send if a hard cap is already met (chapter 3.10, FR-007).
   *
   * Reads the caps and the usage in the transaction that is about to write, with
   * the usage row taken `FOR UPDATE`. Both dimensions, because FR-005 configures
   * a cap for each.
   *
   * THE ACTIVE-USER CHECK ONLY BITES ON A NEW SENDER. A tenant at its user cap is
   * not cut off from the users it already has — the cap is on how many distinct
   * people may send in a month, not on how much they may say. So a sender already
   * counted this period passes, and only the one who would be the next new face
   * is refused. Getting this backwards would suspend a whole tenant the moment
   * their last allowed user sent their second message. */
  private async assertWithinQuota(
    tx: Db,
    period: string,
    userId: string | undefined,
  ): Promise<{
    caps: { messages: Caps; active_users: Caps };
    sent: number;
  } | null> {
    // ONE QUERY, NOT TWO. The caps live on `environments` and the usage on
    // `usage_periods`, and reading them separately costs two round-trips inside
    // the write transaction — which holds a pooled connection for the duration.
    // Above the pool size that queues, and T033 measured the two-query version at
    // 7.95ms per send against 1.45ms unconfigured at 32-way concurrency. Joined,
    // it is one round-trip on two primary keys.
    const [env] = await tx
      .select({
        quotaConfig: environments.quotaConfig,
        messagesSent: usagePeriods.messagesSent,
      })
      .from(environments)
      .leftJoin(
        usagePeriods,
        and(
          eq(usagePeriods.environmentId, environments.id),
          eq(usagePeriods.period, period),
        ),
      )
      .where(eq(environments.id, this.environmentId));

    const messages_ = capsFor(env?.quotaConfig, "messages").caps;
    const users_ = capsFor(env?.quotaConfig, "active_users").caps;
    // Nothing configured at all — no cap and no threshold — and the whole block
    // is skipped. The unconfigured tenant is the common case and pays one
    // indexed read for it.
    if (
      messages_.hard === null &&
      messages_.soft === null &&
      users_.hard === null &&
      users_.soft === null
    ) {
      return null;
    }

    const sent = env?.messagesSent ?? 0;

    if (messages_.hard !== null && sent >= messages_.hard) {
      // THE CROSSING IS WRITTEN BEFORE THE REFUSAL IS RAISED (FR-013a).
      //
      // Usually the send that reached the cap already recorded 100%. Two cases
      // where it did not: a cap lowered below current usage, which no send
      // crossed, and a soft threshold configured at the same value as the hard
      // cap. The email has to survive the send that did not, so the row goes in
      // first and the throw comes after. `ON CONFLICT DO NOTHING` makes the
      // usual case free.
      const organisationId = await this.organisationOf(tx);
      if (organisationId) {
        await this.recordCrossings(
          tx,
          period,
          "messages",
          sent - 1,
          sent,
          messages_,
          organisationId,
        );
      }
      throw new QuotaExceededError({
        dimension: "messages",
        usage: sent,
        quota: messages_.hard,
        period,
      });
    }

    if (users_.hard === null || userId === undefined) {
      return { caps: { messages: messages_, active_users: users_ }, sent };
    }

    const [already] = await tx
      .select({ userId: usageActiveUsers.userId })
      .from(usageActiveUsers)
      .where(
        and(
          eq(usageActiveUsers.environmentId, this.environmentId),
          eq(usageActiveUsers.period, period),
          eq(usageActiveUsers.userId, userId),
        ),
      );
    if (already) {
      return { caps: { messages: messages_, active_users: users_ }, sent };
    }

    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(usageActiveUsers)
      .where(
        and(
          eq(usageActiveUsers.environmentId, this.environmentId),
          eq(usageActiveUsers.period, period),
        ),
      );
    const active = count?.n ?? 0;
    if (active >= users_.hard) {
      throw new QuotaExceededError({
        dimension: "active_users",
        usage: active,
        quota: users_.hard,
        period,
      });
    }
    return { caps: { messages: messages_, active_users: users_ }, sent };
  }

  /** Write a row for each threshold a usage increase crossed (chapter 3.10,
   * FR-014, FR-016).
   *
   * IN THE SAME TRANSACTION AS THE THING THAT CAUSED IT. The crossing and the
   * message commit together or neither does, which is the same argument the
   * event above them makes and the reason there is no periodic sweep in this
   * chapter at all: usage only ever rises because of a send, and the send knows
   * the value before and after, so it knows what it crossed (research R5).
   *
   * THE PERCENTAGE IS OF `hard ?? soft`. A soft threshold with no hard cap is
   * still a figure an operator asked to be warned about, and 100% of it is worth
   * an email even though nothing will be refused.
   *
   * `ON CONFLICT DO NOTHING` against `quota_notifications_once_per_threshold` is
   * what makes it at-most-once (FR-015) — the schema, not this code. A concurrent
   * double-crossing resolves to one row rather than two emails. */
  private async recordCrossings(
    tx: Db,
    period: string,
    dimension: Dimension,
    before: number,
    after: number,
    caps: { hard: number | null; soft: number | null },
    organisationId: string,
  ): Promise<void> {
    const reference = caps.hard ?? caps.soft;
    if (reference === null) return;
    const crossed = thresholdsCrossed(before, after, reference);
    if (crossed.length === 0) return;

    await tx
      .insert(quotaNotifications)
      .values(
        crossed.map((threshold) => ({
          id: randomUUID(),
          environmentId: this.environmentId,
          organisationId,
          period,
          dimension,
          threshold,
          quota: reference,
          usageAtCrossing: after,
        })),
      )
      .onConflictDoNothing();
  }

  /** The organisation an environment belongs to — who gets told. */
  private async organisationOf(tx: Db): Promise<string | null> {
    const [row] = await tx
      .select({ organisationId: applications.organisationId })
      .from(environments)
      .innerJoin(applications, eq(applications.id, environments.applicationId))
      .where(eq(environments.id, this.environmentId));
    return row?.organisationId ?? null;
  }

  /** Fetch a message by its idempotency key within a channel — the
   * recovery leg of 2.3's duplicate-recognised path. The channel join
   * carries the tenant scope: every query in this layer answers only for
   * its own environment, private helpers included (constitution I). */
  private async getMessageByIdempotencyKey(
    tx: Db,
    channelId: string,
    idempotencyKey: string,
  ): Promise<MessageRow> {
    const [row] = await tx
      .select({
        id: messages.id,
        channel_id: messages.channelId,
        seq: messages.sequence,
        text: messages.text,
        created_at: messages.createdAt,
      })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(messages.channelId, channelId),
          eq(messages.idempotencyKey, idempotencyKey),
          eq(channels.environmentId, this.environmentId),
        ),
      );
    // The row MUST exist: this method is only reached when the insert
    // conflicted on the idempotency index, so the key is already there.
    if (!row) {
      throw new Error(
        `idempotency key ${idempotencyKey} conflicted but its message is missing — index inconsistency`,
      );
    }
    return { ...row, created_at: toIso(row.created_at) };
  }

  /** Does this channel resolve IN THIS TENANT? (chapter 2.8.)
   *
   * The write path has asked since 2.2 — it needs the channel row to lock —
   * so it answers a foreign id with a 404. The read path never asked: a
   * tenant-scoped query over a foreign channel simply returns no rows, and
   * the endpoint dressed that as an empty page. The milestone suite caught
   * the two doors disagreeing about the same resource. */
  async channelExists(channelId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.environmentId, this.environmentId),
        ),
      );
    return rows.length > 0;
  }

  /** History reads (chapter 2.4): one page of messages anchored to a
   * sequence position, in either direction (FR-MSG-09), riding the
   * messages_channel_seq index in its natural order. The channel join
   * carries the tenant scope, so a foreign channel id pages nothing.
   *
   * Anchors are strictly EXCLUSIVE: the cursor names the last row the
   * client already has. Inclusive comparisons would serve that row twice,
   * once per page — offset drift rebuilt at a single row's scale.
   */
  async listMessages(
    channelId: string,
    {
      beforeSeq,
      afterSeq,
      limit,
    }: { beforeSeq?: number; afterSeq?: number; limit: number },
  ): Promise<MessageWithSender[]> {
    const columns = {
      id: messages.id,
      channel_id: messages.channelId,
      seq: messages.sequence,
      // The sender joins the read path in 2.7 (the IOU 2.6 wrote): resume
      // must emit frames identical to live ones, and a reader that gets a
      // different shape depending on which door it came through is a client
      // bug waiting for a reconnect.
      user: users.externalId,
      text: messages.text,
      created_at: messages.createdAt,
    };
    const scoped = (extra?: SQL) =>
      and(
        eq(messages.channelId, channelId),
        eq(channels.environmentId, this.environmentId),
        ...(extra ? [extra] : []),
      );
    const rows = await (afterSeq === undefined
      ? this.db
          .select(columns)
          .from(messages)
          .innerJoin(channels, eq(channels.id, messages.channelId))
          // LEFT, not INNER: an unattributed row must still be READ. An
          // inner join here would make those rows vanish from history —
          // silent data loss dressed up as a query.
          .leftJoin(users, eq(users.id, messages.userId))
          .where(
            scoped(
              beforeSeq === undefined
                ? undefined
                : lt(messages.sequence, beforeSeq),
            ),
          )
          .orderBy(desc(messages.sequence))
          .limit(limit)
      : this.db
          .select(columns)
          .from(messages)
          .innerJoin(channels, eq(channels.id, messages.channelId))
          // LEFT, not INNER: an unattributed row must still be READ. An
          // inner join here would make those rows vanish from history —
          // silent data loss dressed up as a query.
          .leftJoin(users, eq(users.id, messages.userId))
          .where(scoped(gt(messages.sequence, afterSeq)))
          .orderBy(asc(messages.sequence))
          .limit(limit));
    return rows.map((row) => ({ ...row, created_at: toIso(row.created_at) }));
  }

  /** Resume backfill (chapter 2.7, FR-RTM-03): for each cursor, everything
   * the client has not applied yet — capped, with an honest truncation
   * signal per channel (FR-RTM-04).
   *
   * Membership is evaluated NOW, not when the cursor was minted: a channel
   * the user was removed from while offline backfills nothing, and a cursor
   * naming a channel in another tenant is a no-op rather than a leak
   * (constitution I, and the members join is what enforces it).
   *
   * One query per channel, deliberately. A single statement would need a
   * window function to apply a per-channel cap, and the loop is bounded by
   * the caller's membership — each iteration is an index scan on
   * (channel_id, sequence) starting exactly where the client stopped.
   */
  async backfill(
    userId: string,
    cursors: Record<string, number>,
    /** Required, not defaulted: FR-RTM-04's ceiling is a contract number,
     * and the contract lives one layer up. The repository enforces a cap;
     * it does not get to choose it. */
    limit: number,
  ): Promise<
    Record<string, { messages: MessageWithSender[]; truncated: boolean }>
  > {
    const out: Record<
      string,
      { messages: MessageWithSender[]; truncated: boolean }
    > = {};
    for (const [channelId, since] of Object.entries(cursors)) {
      const [member] = await this.db
        .select({ channel_id: members.channelId })
        .from(members)
        .innerJoin(channels, eq(channels.id, members.channelId))
        .where(
          and(
            eq(members.channelId, channelId),
            eq(members.userId, userId),
            eq(channels.environmentId, this.environmentId),
          ),
        );
      if (!member) continue;
      // limit + 1 is how the cap answers two questions with one scan: the
      // page, and whether there was more.
      const rows = await this.listMessages(channelId, {
        afterSeq: since,
        limit: limit + 1,
      });
      out[channelId] = {
        messages: rows.slice(0, limit),
        truncated: rows.length > limit,
      };
    }
    return out;
  }

  /** Every message in the channel, ordered by sequence — tenant-scoped
   * like everything else here. DECISION (chapter 2.3): this exists for
   * the idempotency suite's row counts; 2.4 replaces it with the real
   * paginated read, and this method retires with that chapter. */
  async listMessagesRaw(
    channelId: string,
  ): Promise<{ id: string; text: string | null; seq: number }[]> {
    return this.db
      .select({
        id: messages.id,
        text: messages.text,
        seq: messages.sequence,
      })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(messages.channelId, channelId),
          eq(channels.environmentId, this.environmentId),
        ),
      )
      .orderBy(asc(messages.sequence));
  }
}
