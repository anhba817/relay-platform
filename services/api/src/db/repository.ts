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

import type { Attachment } from "@relay/protocol";

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
  messageEdits,
  readPositions,
  memberships,
  messages,
  organisations,
  outbox,
  quotaNotifications,
  usageActiveUsers,
  usageConnections,
  usagePeriods,
  users,
  webhookDeadLetters,
  webhookDeliveries,
  webhookDisableNotifications,
  webhookEndpoints,
} from "./schema";
import {
  membershipEvent,
  messageCreatedEvent,
  messageDeletedEvent,
  messageUpdatedEvent,
} from "../outbox/event";
import { capsFor, type Caps } from "../quotas/config";
import { thresholdsCrossed } from "../quotas/policy";
import { creditFor, highWaterMark } from "../quotas/credit";
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

/** Write a row for each threshold a usage increase crossed (chapter 3.10,
 * FR-RTL-07), and the organisation to tell about it.
 *
 * STANDALONE SINCE CHAPTER 3.11, and the reason is the same one `usageFor` and
 * `creditConnectionMinutes` give: `Repository` closes over an `environmentId` by
 * construction, and the caller that now needs this is the usage report route,
 * which holds a PLATFORM principal and therefore no environment at all. The
 * private methods on `Repository` stay as one-line delegations, so chapter 3.10's
 * two call sites inside `sendMessage` read exactly as they did.
 *
 * Copying the crossing logic into the platform path instead would have made a
 * fifth place that has to agree about thresholds. Moving it costs about forty
 * lines and changes no behaviour, which T056a verified against the full lane
 * before anything was written on top of it.
 *
 * IN THE SAME TRANSACTION AS THE THING THAT CAUSED IT. The crossing and the
 * credit commit together or neither does — which is also why there is no periodic
 * sweep in either chapter: usage only ever rises because of an event, and the
 * event knows the value before and after, so it knows what it crossed.
 *
 * THE PERCENTAGE IS OF `hard ?? soft`. A soft threshold with no hard cap is still
 * a figure an operator asked to be warned about.
 *
 * `ON CONFLICT DO NOTHING` against `quota_notifications_once_per_threshold` is
 * what makes it at-most-once — the schema, not this code. */
export async function recordCrossings(
  tx: Db,
  environmentId: string,
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
        environmentId,
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
export async function organisationOf(
  tx: Db,
  environmentId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ organisationId: applications.organisationId })
    .from(environments)
    .innerJoin(applications, eq(applications.id, environments.applicationId))
    .where(eq(environments.id, environmentId));
  return row?.organisationId ?? null;
}

/** Everything the connect path needs, in ONE round trip (chapter 3.11,
 * FR-RTL-05, FR-RTL-06).
 *
 * ENFORCED AT THE DOOR, because that is the operation this dimension meters. The
 * messages cap refuses sends; the connection-minutes cap refuses connects. A cap
 * that only refused sends would leave an idle listener burning the metered
 * resource with nothing to stop it.
 *
 * ONE QUERY, AND THE PLAN SAID TWO. Research R7 chose "a second call on the same
 * request rather than a heavier version of the first", because chapter 3.10's H2
 * had refused to put a usage join inside `environmentLimits`. H2 is still right
 * and `environmentLimits` is untouched — its OTHER caller is
 * `rate-limit.middleware.ts`, which runs on every `/v1` request and must not pay
 * for a join it never reads.
 *
 * But two calls cost what a join would have, at concurrency, and it was measured:
 * connect latency at 32-way went from 15.0ms to 17.6ms across four runs clustered
 * inside 0.7ms, and folding them back recovered 0.8ms of it. The mechanism is the
 * one chapter 3.10's T033 already recorded — an extra round trip holds a pooled
 * connection for the duration, and above the pool size that queues.
 *
 * THE UNCONFIGURED TENANT still pays one indexed read and leaves. */
export async function connectPolicy(
  db: Db,
  environmentId: string,
  period: string,
): Promise<{
  limits: Record<LimitedOperation, number>;
  used: number;
  caps: Caps;
}> {
  const [row] = await db
    .select({
      rest: environments.restLimitPerMinute,
      send: environments.sendLimitPerMinute,
      connect: environments.connectLimitPerMinute,
      quotaConfig: environments.quotaConfig,
      connectionMinutes: usagePeriods.connectionMinutes,
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

  const limits = {
    rest: row?.rest ?? DEFAULT_LIMITS.rest,
    send: row?.send ?? DEFAULT_LIMITS.send,
    connect: row?.connect ?? DEFAULT_LIMITS.connect,
  };
  const caps = capsFor(row?.quotaConfig, "connection_minutes").caps;
  const used = row?.connectionMinutes ?? 0;

  if (caps.hard !== null && used >= caps.hard) {
    throw new QuotaExceededError({
      dimension: "connection_minutes",
      usage: used,
      quota: caps.hard,
      period,
    });
  }
  return { limits, used, caps };
}

/** The same verdict without the limits, for callers that need only the answer. */
export async function assertConnectionsWithinQuota(
  db: Db,
  environmentId: string,
  period: string,
): Promise<{ used: number; caps: Caps }> {
  const { used, caps } = await connectPolicy(db, environmentId, period);
  return { used, caps };
}

/** Credit a batch of usage reports (chapter 3.11, FR-RTL-05/FR-RTL-05/FR-RTL-05).
 *
 * A STANDALONE FUNCTION, NOT A `Repository` METHOD, and the reason is the same
 * one `usageFor` below gives: the caller is the platform, not a tenant.
 * `Repository` closes over an `environmentId` by construction — that is
 * constitution I expressed as a type — and a platform principal deliberately
 * carries none. `expandEventToDeliveries` and `recordAttemptOutcome` set this
 * precedent for the dispatcher's routes; this is the gateway's.
 *
 * WHAT MAKES A REPLAY FREE. A report says what a connection has consumed IN
 * TOTAL, so the credit is `max(0, reported - credited)` and the stored figure is
 * `max(reported, credited)`. Both live in `quotas/credit.ts`, pure and tested
 * without a database, because those two lines are the whole protocol.
 *
 * THE LOCK CHAPTER 3.10 WANTED AND COULD NOT HAVE. Crediting is read-then-write,
 * so it takes `SELECT … FOR UPDATE` on the accounting row. 3.10 needed the same
 * lock on the usage row and hit `FOR UPDATE cannot be applied to the nullable
 * side of an outer join`, because its caps and usage had become one joined read.
 * Here the lock is a single table by primary key and Postgres allows it — the
 * same instinct, in the one place it is permitted.
 *
 * A CONNECTION MAY NOT CHANGE ENVIRONMENT. The row's `environment_id` is written
 * by the first report and never updated; a later report naming a different one
 * throws rather than reconciling. A connection moving tenants is either a bug or
 * an attempt, and constitution I makes that a correctness question. */
export class ConnectionEnvironmentConflictError extends Error {
  readonly connectionId: string;

  constructor(connectionId: string) {
    super(`connection ${connectionId} was first reported for another environment`);
    this.name = "ConnectionEnvironmentConflictError";
    this.connectionId = connectionId;
  }
}

export async function creditConnectionMinutes(
  db: Db,
  entries: ReadonlyArray<{
    connectionId: string;
    environmentId: string;
    period: string;
    minutes: number;
  }>,
): Promise<number> {
  return db.transaction(async (tx) => {
    let credited = 0;
    /** Per `environment|period`, the roll-up before this batch touched it and
     * after. Collected during the credit and used for the crossings below. */
    const moved = new Map<
      string,
      { environmentId: string; period: string; before: number; after: number }
    >();
    for (const entry of entries) {
      const [existing] = await tx
        .select({
          minutes: usageConnections.minutes,
          environmentId: usageConnections.environmentId,
        })
        .from(usageConnections)
        .where(
          and(
            eq(usageConnections.connectionId, entry.connectionId),
            eq(usageConnections.period, entry.period),
          ),
        )
        .for("update");

      if (existing && existing.environmentId !== entry.environmentId) {
        throw new ConnectionEnvironmentConflictError(entry.connectionId);
      }

      // A report naming a connection nothing has seen is accepted as that
      // connection's FIRST. The api is never told when a connection opens — the
      // first it hears of any of them is a report — so "unknown" and "first" are
      // the same state and there is nothing to tell them apart with (R20).
      const already = existing?.minutes ?? 0;
      const delta = creditFor(entry.minutes, already);
      const stored = highWaterMark(entry.minutes, already);

      await tx
        .insert(usageConnections)
        .values({
          connectionId: entry.connectionId,
          period: entry.period,
          environmentId: entry.environmentId,
          minutes: stored,
        })
        .onConflictDoUpdate({
          target: [usageConnections.connectionId, usageConnections.period],
          set: { minutes: stored, lastSeenAt: new Date() },
        });

      if (delta === 0) continue;
      credited += delta;

      const [rolled] = await tx
        .insert(usagePeriods)
        .values({
          environmentId: entry.environmentId,
          period: entry.period,
          connectionMinutes: delta,
        })
        .onConflictDoUpdate({
          target: [usagePeriods.environmentId, usagePeriods.period],
          set: {
            connectionMinutes: sql`${usagePeriods.connectionMinutes} + ${delta}`,
          },
        })
        .returning({ after: usagePeriods.connectionMinutes });

      // The figure before and after, per environment per period. `RETURNING`
      // gives the after; the before is it minus what this entry just added,
      // which is exact because the row is being written inside this transaction.
      const key = `${entry.environmentId}|${entry.period}`;
      const after = rolled?.after ?? delta;
      const seen = moved.get(key);
      moved.set(key, {
        environmentId: entry.environmentId,
        period: entry.period,
        before: seen?.before ?? after - delta,
        after,
      });
    }

    // THE CROSSINGS, IN THE SAME TRANSACTION AS THE CREDIT (chapter 3.11,
    // FR-RTL-07/FR-RTL-07). The report knows the figure before and after, so it knows
    // which thresholds it crossed — which is why this chapter has no periodic
    // sweep either, for the second chapter running (research R5).
    //
    // AFTER the credit loop rather than inside it, because a batch can carry
    // several entries for one environment and period — a socket that spanned a
    // month boundary, or a hundred sockets on one instance — and crossing 80%
    // once is one email however many entries pushed it there.
    for (const group of moved.values()) {
      const [env] = await tx
        .select({ quotaConfig: environments.quotaConfig })
        .from(environments)
        .where(eq(environments.id, group.environmentId));
      const caps = capsFor(env?.quotaConfig, "connection_minutes").caps;
      if (caps.hard === null && caps.soft === null) continue;

      const organisationId = await organisationOf(tx, group.environmentId);
      if (organisationId === null) continue;

      await recordCrossings(
        tx,
        group.environmentId,
        group.period,
        "connection_minutes",
        group.before,
        group.after,
        caps,
        organisationId,
      );
    }
    return credited;
  });
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
  connectionMinutes: number;
  messageQuota: number | null;
  activeUserQuota: number | null;
  connectionMinuteQuota: number | null;
}> {
  const [row] = await db
    .select({
      messagesSent: usagePeriods.messagesSent,
      // Chapter 3.11's figure, read from the ROLL-UP and never summed over
      // `usage_connections` — that sum is proportional to the tenant's
      // connections for the month, which is chapter 3.10's R1 argument in a new
      // costume.
      connectionMinutes: usagePeriods.connectionMinutes,
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
    connectionMinutes: row?.connectionMinutes ?? 0,
    messageQuota: capsFor(row?.quotaConfig, "messages").caps.hard,
    activeUserQuota: capsFor(row?.quotaConfig, "active_users").caps.hard,
    connectionMinuteQuota: capsFor(row?.quotaConfig, "connection_minutes").caps
      .hard,
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
  /** Chapter 3.15, FR-023. Both columns have existed since chapter 2.1 and **no route
   * has ever written or read either one** — two of the four dead columns this feature
   * exists to give readers. They are on the row rather than fetched by a second query
   * because every caller that wants a profile wants all of it. */
  avatar_url: string | null;
  metadata: Record<string, unknown>;
  /** Chapter 3.15, FR-031. Read on the send path and at connect. Like `deleted_at`, it
   * is selected rather than filtered so a caller can tell the states apart — a
   * repository that hid banned users would make the ban unobservable and the refusal
   * untestable. */
  banned_at: string | null;
  /** Chapter 3.15, FR-017. A deleted user KEEPS THEIR ROW: `ON DELETE SET NULL` on
   * `messages.user_id` would satisfy the letter of "messages are preserved" and break
   * delivery, because `backfill.controller`'s `toFrame` drops a senderless row — so
   * "authored by a deleted user" and "authored by nobody" are different states and
   * only one of them is the clause.
   *
   * Every route that names a user in its path reads this and answers 404. It is
   * selected here rather than filtered in the query so a caller can tell the two
   * apart: a repository that hid deleted rows would make the marker unobservable and
   * the deletion untestable. */
  deleted_at: string | null;
  /** Chapter 3.17, FR-USR-07. What kind of thing this user is — `'person'` or `'bot'`.
   *
   * ON EVERY USER, not only bots. A reader that had to infer personhood from a null
   * description would be inferring it from the absence of something, and FR-003 asks
   * for a stored property rather than an inference. */
  kind: "person" | "bot";
  /** What the software is, and why it posts. Null for a person, and
   * `users_bot_description_check` makes it non-null for a bot at the database. */
  description: string | null;
}

export interface ChannelRow {
  id: string;
  external_id: string;
  /** The column has been `"public" | "private"` with a CHECK constraint since
   * chapter 2.1, and chapter 3.15 gave it its first DECISION. Before that it was
   * selected and returned by the create route — read, but consulted by nothing:
   * no conditional anywhere branched on it, so FR-CHN-05's private guarantee was
   * unimplemented while the value round-tripped.
   *
   * Now `sendMessage`, the by-id read, history and join all branch on it. */
  type: "public" | "private";
  name: string | null;
  metadata: Record<string, unknown>;
}

/** What `addMember` did. `not_found` deliberately covers "the channel is not
 * yours", "the user is not yours" and "neither exists" — the caller must not be
 * able to tell those apart (FR-018, FR-TEN-05). */
export type AddMemberOutcome = "added" | "already_a_member" | "not_found";

export interface MessageRow {
  id: string;
  channel_id: string;
  seq: number;
  text: string | null;
  /** Chapter 3.24 (FR-001, FR-007). **REQUIRED, unlike `edited_at` below**, and the
   * contrast is the decision.
   *
   * `edited_at?` is optional so write paths need not spell `edited_at: null`, and that
   * convenience is exactly what made chapter 3.24's `internalSendResponseSchema` a break
   * waiting to happen: a field the type lets you omit is a field the gateway's strict
   * parse refuses at runtime, with no compiler anywhere in between. Required here means
   * every path that builds a row is named by `tsc` instead.
   *
   * `Attachment[]` AND NOT `Attachment[] | null`, so the null lives only in the column.
   * FR-007: a message with none is returned with an empty list rather than an absent or
   * null field, and the `?? []` that makes that true belongs at the read, once. */
  attachments: Attachment[];
  created_at: string;
  /** When it was last edited, or `null` (chapter 3.23, FR-003). Optional on this
   * interface rather than required, because the WRITE paths build a row that has never
   * been edited and would each have to spell `edited_at: null`. The read paths fill it
   * in; `EditedMessageRow` narrows it to a string. */
  edited_at?: string | null;
  /** Chapter 2.3 (FR-MSG-04): true when a retry was recognised by the
   * idempotency index and the ORIGINAL message was returned instead of
   * a new insert. The service layer uses this to decide response shape. */
  duplicate?: boolean;
}

/** An edited message, as the edit path returns it (chapter 3.23, FR-001, FR-003).
 *
 * `edited_at` IS NOT OPTIONAL HERE. Every row this shape describes has just been edited,
 * so a `string | null` would be a type saying the impossible is possible. `MessageRow`'s
 * read shape carries the nullable version, because a message that was never edited is
 * the common case there. */
export interface EditedMessageRow extends MessageRow {
  edited_at: string;
  /** What it said before, returned so the caller does not have to read it back to know
   * the history row landed. Never on the public wire: `not_message_author` exists
   * because rewriting somebody's words is not the same as removing them, and echoing the
   * superseded text to whoever asked would make the edit-history route (FR-023a) a
   * formality. `messages.controller.ts` spells its response fields out one by one. */
  prior_text: string;
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

/** A write refused because the channel is archived (chapter 3.15, FR-020, FR-021).
 *
 * A TYPED DOMAIN ERROR, not a `protocolError` thrown from here. The repository has
 * raised `ChannelNotFoundError` since chapter 2.2 and let the service map it to a
 * status — the data layer knows the fact, the service knows the wire. Reaching for
 * `protocolError` here would put an HTTP status in the layer whose whole job is to
 * not know about HTTP. */
export class ChannelArchivedError extends Error {
  constructor(public readonly channelId: string) {
    super(`channel archived: ${channelId}`);
    this.name = "ChannelArchivedError";
  }
}

/** A write or a connect refused because the user is banned (chapter 3.15, FR-031).
 *
 * FIRST IN FR-021a's ORDER, and the ban check runs BEFORE the channel is read at all —
 * so a banned user gets one answer for every channel id, whether it exists, belongs to
 * somebody else, or was invented. Any other position leaks: check the channel first and
 * a banned user learns which channel ids are real. */
/** An application credential named a person (chapter 3.17, FR-007, FR-007a).
 *
 * ITS OWN CLASS, NOT A `ChannelNotFoundError`, because the two say different things and
 * the service maps them to different codes. Carries the sender's INTERNAL id and never
 * the customer's identifier: the message on the wire names neither the person asked for
 * nor the bots that would have been accepted (SC-005). */
export class SenderNotPermittedError extends Error {
  constructor(readonly userId: string) {
    super("an application credential may send only as a bot user");
    this.name = "SenderNotPermittedError";
  }
}

/** The message id does not name a message of this channel (chapter 3.23, FR-014).
 *
 * ITS OWN CLASS, SEPARATE FROM `ChannelNotFoundError`, and the separation is not about
 * the wire — both become a bare 404. It is about what the repository can say honestly. A
 * visible channel and an unknown message id inside it is a different fact from a channel
 * this tenant cannot see, and a layer that threw the channel error for both would be
 * telling the service something untrue in order to produce an answer that happens to
 * match. The indistinguishability FR-014 requires is a property of the two RESPONSES,
 * which `messages.service.ts` produces, not of the two causes. */
export class MessageNotFoundError extends Error {
  constructor(public readonly messageId: string) {
    super(`message not found: ${messageId}`);
    this.name = "MessageNotFoundError";
  }
}

/** The caller did not write this message (chapter 3.23, FR-013, FR-018, FR-022).
 *
 * ALSO THROWN WHEN THE MESSAGE HAS NO AUTHOR, which is FR-018 and is the arm worth
 * naming: 121,250 rows in the test lane carry a null `user_id`, written before chapter
 * 2.6 recorded a sender, and none of them can be edited by anybody. "Nobody wrote this"
 * and "somebody else wrote this" are the same refusal — there is no caller for whom the
 * authorship check can pass — and collapsing them means the answer cannot depend on
 * which kind of unauthored row was asked about.
 *
 * A DELETED MESSAGE IS NOT THIS ERROR. A tombstone keeps its `user_id`, so its author
 * still passes the authorship check and is refused by `MessageDeletedError` below for a
 * reason they can act on. */
export class NotMessageAuthorError extends Error {
  constructor(public readonly messageId: string) {
    super(`the caller did not write message ${messageId}`);
    this.name = "NotMessageAuthorError";
  }
}

/** An edit was asked for on a tombstone (chapter 3.23, FR-010).
 *
 * REFUSED RATHER THAN DEFINED, and `prior_text TEXT NOT NULL` is why the alternative is
 * not available: a tombstone has no text to preserve, so an edit of one would have to
 * either write a null into a NOT NULL column — a 500 the caller cannot act on — or
 * invent a value for what the message used to say. SAD §6.1 published the constraint
 * and this is the behaviour that follows from it. */
export class MessageDeletedError extends Error {
  constructor(public readonly messageId: string) {
    super(`message deleted: ${messageId}`);
    this.name = "MessageDeletedError";
  }
}

export class UserBannedError extends Error {
  constructor(public readonly userId: string) {
    super(`user banned: ${userId}`);
    this.name = "UserBannedError";
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

  /** IDEMPOTENT, for `createChannel`'s reason and found the same way (chapter
   * 3.12). This was a plain insert too, and the members endpoint creates a user
   * on first membership — so a second identical request would have raised against
   * `users_environment_id_external_id_unique` and answered `internal_error`. R14a
   * named `addMember` and `createChannel`; this is the third function on the same
   * request path and it had the same fault.
   *
   * Not a read-then-insert in the service, for the same reason as there:
   * concurrent first-membership adds of one user race, and Principle II requires
   * the unique index to be what enforces this rather than application memory. */
  async createUser(externalId: string, displayName?: string): Promise<UserRow> {
    const id = randomUUID();
    const inserted = await this.db
      .insert(users)
      .values({
        id,
        environmentId: this.environmentId,
        externalId,
        displayName: displayName ?? null,
      })
      .onConflictDoNothing({ target: [users.environmentId, users.externalId] })
      .returning({ id: users.id });

    if (inserted.length > 0) {
      // `deleted_at: null` on the fresh row, stated rather than spread: a user
      // created now is not deleted, and an insert that returned the field would cost
      // a column in the RETURNING clause to learn what the code already knows.
      return {
        id,
        external_id: externalId,
        display_name: displayName ?? null,
        avatar_url: null,
        metadata: {},
        banned_at: null,
        deleted_at: null,
        // `createUser` CANNOT MAKE A BOT, and that is deliberate (chapter 3.17). Its
        // callers are the member-add and the token mint, where an unknown identifier
        // arrives with nothing but a name; a bot needs a description, so it is created
        // through the upsert where one can be supplied. This is also why `person -> bot`
        // has an escape at all — see `upsertUser`.
        kind: "person",
        description: null,
      };
    }
    const existing = await this.getUserByExternalId(externalId);
    if (existing === null) throw new Error(`user ${externalId} could not be created or read`);
    // The DISPLAY NAME OF THE EXISTING ROW WINS. A second call is not an update:
    // FR-CHN-04 asks for membership, and quietly renaming a user because someone
    // re-sent a member list would be a write nobody asked for.
    return existing;
  }

  async getUserByExternalId(externalId: string): Promise<UserRow | null> {
    const rows = await this.db
      .select({
        id: users.id,
        external_id: users.externalId,
        display_name: users.displayName,
        avatar_url: users.avatarUrl,
        metadata: users.metadata,
        bannedAt: users.bannedAt,
        deletedAt: users.deletedAt,
        kind: users.kind,
        description: users.description,
      })
      .from(users)
      .where(
        and(
          eq(users.environmentId, this.environmentId),
          eq(users.externalId, externalId),
        ),
      );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          external_id: row.external_id,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
          // `as` AND NOT `?? {}`. The column is `notNull().default({})`, so the driver
          // never hands back null — and chapter 3.12 removed `addMember`'s
          // `(inserted.rowCount ?? 0)` for exactly this reason: an arm nothing can take,
          // bought for nothing, in the one file constitution VI asks 100% of.
          metadata: row.metadata as Record<string, unknown>,
          banned_at: row.bannedAt === null ? null : toIso(row.bannedAt),
          deleted_at: row.deletedAt === null ? null : toIso(row.deletedAt),
          // `as` for the same reason as `metadata` above: the column is
          // `notNull().default('person')` and `users_kind_check` bounds it to two
          // values, so a `?? "person"` here would be an arm the database cannot produce.
          kind: row.kind as "person" | "bot",
          description: row.description,
        };
  }

  /** IDEMPOTENT ON THE CUSTOMER'S OWN IDENTIFIER (FR-017, FR-CHN-02).
   *
   * This was a plain insert until chapter 3.13, which is fine for a fixture and
   * cannot back an endpoint: a repeated `external_id` raises against
   * `channels_environment_id_external_id_unique`, and `ProtocolErrorFilter`
   * renders a unique violation as `internal_error`. The second call in an
   * integration guide would have been a 500.
   *
   * `ON CONFLICT DO NOTHING RETURNING` and not a read-then-insert in the
   * service: that races, and Principle II requires idempotency enforced at the
   * storage layer by a unique index rather than in application memory. The
   * fallback read is not the check — it is how the loser of a race learns what
   * the winner wrote. */
  async createChannel(
    externalId: string,
    type: ChannelRow["type"],
    name?: string,
    metadata?: Record<string, unknown>,
  ): Promise<ChannelRow & { created: boolean }> {
    const id = randomUUID();
    const inserted = await this.db
      .insert(channels)
      .values({
        id,
        environmentId: this.environmentId,
        externalId,
        type,
        name: name ?? null,
        ...(metadata !== undefined ? { metadata } : {}),
      })
      .onConflictDoNothing({ target: [channels.environmentId, channels.externalId] })
      .returning({ id: channels.id });

    if (inserted.length > 0) {
      return {
        id,
        external_id: externalId,
        type,
        name: name ?? null,
        metadata: metadata ?? {},
        created: true,
      };
    }
    const existing = await this.getChannelByExternalId(externalId);
    if (existing === null) {
      // Nothing inserted and nothing there: the row belongs to another
      // environment, which this repository is scoped away from. Callers see the
      // same answer they would see for a channel that does not exist.
      throw new Error(`channel ${externalId} could not be created or read`);
    }
    return { ...existing, created: false };
  }

  async getChannelByExternalId(externalId: string): Promise<ChannelRow | null> {
    const rows = await this.db
      .select({
        id: channels.id,
        external_id: channels.externalId,
        type: sql<ChannelRow["type"]>`${channels.type}`,
        name: channels.name,
        metadata: sql<Record<string, unknown>>`${channels.metadata}`,
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
        metadata: sql<Record<string, unknown>>`${channels.metadata}`,
      })
      .from(channels)
      .where(eq(channels.environmentId, this.environmentId))
      .orderBy(asc(channels.externalId));
  }

  /** Membership joins live in channel-land, so the tenant scope rides the
   * channel: the double-scoped SELECT below is what makes a foreign channel
   * id useless. INSERT ... SELECT is where the builder falls short — this
   * is the layer's one raw SQL island, permitted by ADR-16 and kept inside
   * the wall like everything else.
   *
   * THREE OUTCOMES, NOT A BOOLEAN (chapter 3.13, R14a). Until then this returned
   * `false` for all of: the channel is not yours, the user is not yours, and you
   * asked twice. Conflating the first two is right and is the whole point — a
   * foreign id must be indistinguishable from an absent one. Conflating the third
   * with them is wrong, and it cannot back an endpoint: `members`' primary key is
   * `(channel_id, user_id)`, so before the `ON CONFLICT` below a repeat raised a
   * unique violation that reached the wire as `internal_error`.
   *
   * `not_found` keeps the conflation the isolation property needs. The follow-up
   * read distinguishes it from `already_a_member` — and it is a read, not a
   * check-then-write: the insert already happened. */
  /** Chapter 3.20. THIS METHOD HAD NO TRANSACTION AND NOW HAS ONE, which is a
   * different change from adding a statement to an existing one.
   *
   * Constitution II: "State changes and their events MUST commit atomically via the
   * transactional outbox. Publish-after-commit without the outbox is forbidden."
   * Chapter 3.18's Redis publish is legal because `sendMessage` already wrote the
   * durable row inside the transaction that wrote the message; a membership write
   * recorded nothing, so the same publish here would be exactly the case the
   * principle names. The row has to come first, and it has to be atomic with the
   * insert, and there was nothing to put it inside.
   *
   * THE EXTERNAL ID COMES OUT OF `RETURNING`, and the first draft of this chapter
   * took it as a parameter instead. The event a customer receives carries external
   * ids — `MessageCreatedData` fixes that boundary in its own words — and this
   * method holds `users.id`. Adding a parameter was the obvious answer and it broke
   * **68 call sites across 15 files**, twelve of them test fixtures and several
   * inside files other chapters fence: a signature change to a method this old is a
   * fence-chain cost paid by chapters that never mention membership.
   *
   * A subquery in the `RETURNING` clause costs one expression on the inserted branch
   * and nothing anywhere else. The typecheck found the blast radius in four seconds;
   * the alternative would have been found in phase 10. */
  async addMember(
    channelId: string,
    userId: string,
    /** Chapter 3.15, FR-011b. Absent means the column's own default — `member` —
     * which is what keeps every existing caller working unchanged. An entry that
     * names a role is creating a member WITH one rather than changing them into one
     * afterwards, which is what US6's first scenario asks for. */
    role?: string,
  ): Promise<AddMemberOutcome> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute(
        role === undefined
          ? sql`INSERT INTO members (channel_id, user_id)
            SELECT c.id, u.id FROM channels c, users u
            WHERE c.id = ${channelId} AND c.environment_id = ${this.environmentId}
              AND u.id = ${userId} AND u.environment_id = ${this.environmentId}
            ON CONFLICT (channel_id, user_id) DO NOTHING
            RETURNING channel_id,
              (SELECT external_id FROM users WHERE users.id = members.user_id)
                AS user_external_id`
          : sql`INSERT INTO members (channel_id, user_id, role)
            SELECT c.id, u.id, ${role} FROM channels c, users u
            WHERE c.id = ${channelId} AND c.environment_id = ${this.environmentId}
              AND u.id = ${userId} AND u.environment_id = ${this.environmentId}
            ON CONFLICT (channel_id, user_id) DO NOTHING
            RETURNING channel_id,
              (SELECT external_id FROM users WHERE users.id = members.user_id)
                AS user_external_id`,
      );
      // `RETURNING` and `.rows.length`, not `rowCount ?? 0`. `rowCount` is typed
      // `number | null` by the driver and is never null for an INSERT, so the `??`
      // was a branch nothing could take — one uncovered arm in the file
      // constitution VI asks for 100% of, bought for nothing. A row that came back
      // is a row that was inserted.
      if (inserted.rows.length > 0) {
        // ON THE INSERTED BRANCH ONLY, which is `sendMessage`'s rule verbatim: "a
        // recognised idempotent retry returned above without writing anything and
        // must consume no event either." An add that changed nothing publishes
        // nothing and records nothing (FR-005).
        // THE SAME CHECK TWICE, AND THIS COPY IS THE UNREACHABLE ONE. There was a
        // `if (!row.user_external_id) throw` here, on the grounds that a silent `""`
        // is the uuid-in-a-webhook defect wearing a different hat. That is right, and
        // `membershipEvent` already refuses it — `event.test.ts` covers that refusal
        // by name. The subquery cannot miss either: the INSERT's own SELECT already
        // joined `users`, so the row exists by the time `RETURNING` reads it.
        //
        // Two guards, one reachable. The coverage ratchet found the pair as two
        // uncovered lines taking this file from 99% to 98.79%, and the honest answer
        // is to keep the check that a test can reach.
        const row = inserted.rows[0] as { user_external_id: string };
        const event = membershipEvent({
          eventId: randomUUID(),
          environmentId: this.environmentId,
          change: "added",
          occurredAt: new Date().toISOString(),
          membership: { channel_id: channelId, user: row.user_external_id },
        });
        await tx.insert(outbox).values({
          subject: event.subject,
          payload: event.payload,
        });
        return "added";
      }

      const existing = await tx
        .select({ userId: members.userId })
        .from(members)
        .innerJoin(channels, eq(channels.id, members.channelId))
        .where(
          and(
            eq(members.channelId, channelId),
            eq(members.userId, userId),
            eq(channels.environmentId, this.environmentId),
          ),
        );
      return existing.length > 0 ? "already_a_member" : "not_found";
    });
  }

  /** Archive and unarchive, both idempotent (chapter 3.15, FR-020, FR-020a).
   *
   * IDEMPOTENT BY THE WRITE, not by a read-then-write: setting `archived_at` on an
   * already-archived channel writes the same state, and a caller who asks twice
   * meant it once. The returned boolean says whether the channel was FOUND, not
   * whether anything changed — "already archived" and "archived just now" are the
   * same answer to the customer, which is what idempotent means here.
   *
   * `now()` FROM THE DATABASE rather than the app clock, because nothing compares
   * this timestamp against another statement's value. `sendMessage` takes its period
   * from the app clock for the opposite reason: two statements there need the same
   * value and only one of them can be `now()`.
   */
  async archiveChannel(channelId: string): Promise<boolean> {
    const updated = await this.db
      .update(channels)
      .set({ archivedAt: sql`now()` })
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.environmentId, this.environmentId),
        ),
      )
      .returning({ id: channels.id });
    return updated.length > 0;
  }

  async unarchiveChannel(channelId: string): Promise<boolean> {
    const updated = await this.db
      .update(channels)
      .set({ archivedAt: null })
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.environmentId, this.environmentId),
        ),
      )
      .returning({ id: channels.id });
    return updated.length > 0;
  }

  /** Set a member's role (chapter 3.15, FR-011).
   *
   * SCOPED THROUGH THE CHANNEL, like every other write to `members`: that table
   * carries no `environment_id`, so the `EXISTS` is what keeps another tenant's rows
   * out of reach.
   *
   * The CHECK constraint is the second line of defence and the one that matters:
   * `members_role_check` names FR-CHN-04's three, so a value that got past the
   * schema at the edge still cannot land. R8's trap was a constraint that reused
   * `memberships`' vocabulary — it would accept `admin`, refuse `moderator`, and
   * read as correct in review. */
  /** Chapter 3.20. **NO OUTBOX ROW, AND NO FABRIC PUBLISH.** `membership.changed`'s
   * `change` is an enum of `added` and `removed` — chapter 1.3 published it that way
   * and neither member means "role" — and FR-WHK-02's event names are
   * `channel.member_added` and `channel.member_removed`. A role change is a
   * membership write that this chapter's vocabulary cannot express, in either shape.
   *
   * That is a fact about the frame rather than an omission here, and it is stated
   * where somebody will look for it: a reader who sees add and remove producing
   * events will otherwise assume a `PATCH` does too, and find silence. */
  async setMemberRole(
    channelId: string,
    userId: string,
    role: string,
  ): Promise<"set" | "not_a_member"> {
    const updated = await this.db
      .update(members)
      .set({ role })
      .where(
        and(
          eq(members.channelId, channelId),
          eq(members.userId, userId),
          sql`EXISTS (SELECT 1 FROM channels c WHERE c.id = ${channelId}
                       AND c.environment_id = ${this.environmentId})`,
        ),
      )
      .returning({ userId: members.userId });
    return updated.length > 0 ? "set" : "not_a_member";
  }

  /** One member's role, or null when there is no membership. Used by the tests that
   * assert the default rather than reading it out of the DDL. */
  async memberRole(channelId: string, userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ role: members.role })
      .from(members)
      .innerJoin(channels, eq(channels.id, members.channelId))
      .where(
        and(
          eq(members.channelId, channelId),
          eq(members.userId, userId),
          eq(channels.environmentId, this.environmentId),
        ),
      );
    return rows[0]?.role ?? null;
  }

  /** Remove members by user id, up to a hundred in one call, reporting each
   * (chapter 3.15, FR-006, FR-007, FR-008).
   *
   * BULK, BECAUSE THE REQUIREMENT ALWAYS WAS. FR-006 says "up to 100 in one
   * request" and FR-007 says the result is reported per user — which is chapter
   * 3.13's `addMembers` shape in both halves. `contracts/membership.md` specified a
   * single-user `DELETE …/members/:userExternalId` for ten analysis passes, having
   * read "the shape chapter 3.13 chose" as *named outcomes* and dropped *bulk*.
   * Every pass compared requirements to tasks, both said "removal", and identifier
   * coverage read 100% the whole time.
   *
   * NO MESSAGES ARE TOUCHED (FR-008). The removed user's messages stay in history
   * attributed to them: `messages.user_id` still points at a row that still exists,
   * and their socket stops receiving the channel on its next resume because the
   * session is built from `members`.
   *
   * THE READ POSITION GOES WITH THE MEMBERSHIP. `read_positions` is per-member
   * state keyed by `(channel_id, user_id)`, so leaving the row would leave a
   * non-member's position in a per-member table. Adding the user back therefore
   * starts their unread count at the channel's whole history, which is the same
   * thing "no row means position zero" says for a new member.
   *
   * SCOPED THROUGH THE CHANNEL, and the caller has already read it scoped. `members`
   * carries no `environment_id` — the catalogue calls it a `hop` — so the join is
   * what keeps a foreign channel's rows out of reach.
   */
  /** Chapter 3.20. THIS ONE HAD NO TRANSACTION EITHER, and it was already two
   * statements — the member delete and the read-position delete, with nothing
   * between them. **A crash there left a removed member holding a read position**,
   * which this transaction closes as a side effect of carrying the outbox rows.
   * Saying so rather than letting it look incidental: the defect predates this
   * chapter and is fixed here because the fix was free.
   *
   * THE EXTERNAL IDS COME OUT OF `RETURNING`, as `addMember`'s does and for the same
   * reason: a third parameter here was two more call sites, and the pair of them was
   * 68 across 15 files. */
  async removeMembers(
    channelId: string,
    userIds: string[],
  ): Promise<Map<string, "removed" | "not_a_member">> {
    const outcome = new Map<string, "removed" | "not_a_member">();
    if (userIds.length === 0) return outcome;

    // ONE STATEMENT FOR THE BATCH, and `inArray` rather than a built string.
    //
    // The first draft of this method interpolated the ids into raw SQL with
    // `sql.raw(\`ARRAY['${'${'}userIds.join("','")}']::uuid[]\`)`. It typechecked and it
    // would have worked, and it is an injection hole in the one layer that must not
    // have one: these ids arrive in a request body. `inArray` parameterises, which
    // is the only reason to reach for the query builder over a template here.
    //
    // A hundred round trips to answer one request is the cost chapter 2.4 measured
    // away on the read path; there is no reason to reintroduce it on this one.
    return this.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(members)
      .where(
        and(
          eq(members.channelId, channelId),
          inArray(members.userId, userIds),
          // The channel scoped, in the same statement. `members` carries no
          // `environment_id` — the catalogue calls it a `hop` — so this EXISTS is
          // what keeps another tenant's rows out of reach.
          sql`EXISTS (SELECT 1 FROM channels c WHERE c.id = ${channelId}
                       AND c.environment_id = ${this.environmentId})`,
        ),
      )
      .returning({
        userId: members.userId,
        // The event's `user` is what a customer reads, and this table holds only a
        // uuid. One subquery per returned row, on the rows that were actually
        // deleted — never on the ids that were merely asked for.
        userExternalId: sql<string>`(SELECT external_id FROM users
                                      WHERE users.id = ${members.userId})`,
      });
    const removed = new Set(deleted.map((r) => r.userId));

    // ONE ROW PER ID THE `RETURNING` CLAUSE GAVE BACK, not one per id asked for.
    // A bulk call naming five of which two were not members writes three (FR-005).
    // The returning clause already existed; no second query is needed to find out
    // who was actually removed.
    for (const row of deleted) {
      // No guard here either, for the reason the add path states: `membershipEvent`
      // refuses an empty external id and a test reaches that refusal, while a guard
      // in this loop cannot be reached at all.
      const event = membershipEvent({
        eventId: randomUUID(),
        environmentId: this.environmentId,
        change: "removed",
        occurredAt: new Date().toISOString(),
        membership: { channel_id: channelId, user: row.userExternalId },
      });
      await tx.insert(outbox).values({
        subject: event.subject,
        payload: event.payload,
      });
    }

    await tx
      .delete(readPositions)
      .where(
        and(
          eq(readPositions.channelId, channelId),
          eq(readPositions.environmentId, this.environmentId),
          inArray(readPositions.userId, userIds),
        ),
      );

    for (const id of userIds) {
      outcome.set(id, removed.has(id) ? "removed" : "not_a_member");
    }
    return outcome;
    });
  }

  /** How many deliveries an endpoint holds, scoped. Added for chapter 3.12's
   * `expand` attack, which has to read the victim's side to prove nothing moved —
   * and it lives HERE rather than in the test because the restored lint ban
   * (R23, FR-043) puts the query engine in this directory and nowhere else. The
   * isolation suite is written to that constraint rather than exempted from it,
   * which is the whole point of restoring it in the same chapter. */
  async countDeliveriesForEndpoint(endpointId: string): Promise<number> {
    const rows = await this.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.endpointId, endpointId),
          eq(webhookDeliveries.environmentId, this.environmentId),
        ),
      );
    return rows.length;
  }

  /** How many members a channel holds, scoped — FR-CHN-07's ceiling is checked
   * against this rather than against a count the caller supplies. */
  async countMembers(channelId: string): Promise<number> {
    const rows = await this.db
      .select({ userId: members.userId })
      .from(members)
      .innerJoin(channels, eq(channels.id, members.channelId))
      .where(
        and(eq(members.channelId, channelId), eq(channels.environmentId, this.environmentId)),
      );
    return rows.length;
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

  /** Upsert a user by external id, updating the profile fields present (chapter 3.15,
   * FR-025, FR-026).
   *
   * NOT `createUser`, AND THE DIFFERENCE IS THE POINT. `createUser` is deliberately not an
   * update: its comment says so — "the display name of the existing row wins; quietly
   * renaming a user because someone re-sent a member list would be a write nobody asked
   * for". That is right for the member-add, which asks for membership and happens to need a
   * user. FR-026 asks for the opposite here: an entry naming an existing user **updates**
   * it, because this route's subject IS the user record.
   *
   * Two functions rather than a flag, so neither route can accidentally get the other's
   * behaviour. The member-add's caller keeps `createUser`.
   *
   * IT ALSO REVIVES A DELETED USER, which is FR-030 and not an accident.
   * `(environment_id, external_id)` is unique and the row is still there, so presenting
   * the id again has no other honest answer than reusing it. `deleted_at` is cleared and
   * the profile takes whatever this call carries — a revived row does not inherit the
   * profile the deletion wiped.
   *
   * `status` REPORTS WHICH HAPPENED, per entry, in the shape chapter 3.13 chose for
   * `addMember`: a partial outcome is reported per entry rather than collapsed into one
   * status code. */
  async upsertUser(
    externalId: string,
    profile: {
      display_name?: string | null | undefined;
      avatar_url?: string | null | undefined;
      metadata?: Record<string, unknown> | undefined;
      /** Chapter 3.17 (FR-002b). ABSENT MEANS "NO CHANGE", NOT "PERSON" — the column
       * default handles a new row and this method must not apply it to an existing
       * one, or an entry updating a bot's description would silently demote it. */
      kind?: "person" | "bot" | undefined;
      description?: string | undefined;
    },
  ): Promise<{
    user: UserRow;
    /** `kind_conflict` REPORTS A CHANGE RATHER THAN PERFORMING ONE (FR-002a). Zod
     * cannot reach this decision: it depends on the stored row's kind and, for a
     * promotion, on whether that row has ever sent a message. */
    status: "created" | "updated" | "revived" | "kind_conflict";
  }> {
    const id = randomUUID();
    const inserted = await this.db
      .insert(users)
      .values({
        id,
        environmentId: this.environmentId,
        externalId,
        displayName: profile.display_name ?? null,
        avatarUrl: profile.avatar_url ?? null,
        ...(profile.metadata === undefined ? {} : { metadata: profile.metadata }),
        // THE DEFAULT APPLIES HERE AND NOWHERE ELSE (chapter 3.17, FR-002b, T019a).
        // A new row with no `kind` is a person; an existing row with no `kind` is
        // asking for no change, which the update block below is careful about.
        ...(profile.kind === undefined ? {} : { kind: profile.kind }),
        ...(profile.description === undefined
          ? {}
          : { description: profile.description }),
      })
      .onConflictDoNothing({ target: [users.environmentId, users.externalId] })
      .returning({ id: users.id });

    if (inserted.length > 0) {
      return {
        user: {
          id,
          external_id: externalId,
          display_name: profile.display_name ?? null,
          avatar_url: profile.avatar_url ?? null,
          metadata: profile.metadata ?? {},
          banned_at: null,
          deleted_at: null,
          kind: profile.kind ?? "person",
          description: profile.description ?? null,
        },
        status: "created",
      };
    }

    // ONE UNREACHABLE THROW, NOT TWO, and the count is the reason. An earlier version
    // read the row, threw if it was absent, updated it, read it back, and threw again if
    // THAT was absent — two statements for one impossible state (the winner of an
    // `ON CONFLICT` race having its row deleted between two statements of the same call,
    // which nothing in the api can do). `repository.ts` already carried two throws of
    // that class from chapter 3.12 and its lines ratchet sat at 99; a third took the file
    // to 98.92 and the gate went red. The instrument was right: the second throw bought
    // nothing the first did not already say.
    //
    // The pre-image is read for ONE fact the update cannot return — whether the row was
    // deleted before this call, which is what makes the difference between `updated` and
    // `revived`. `UPDATE ... RETURNING` gives post-update values, so there is no way to
    // learn it from the write itself.
    const [before] = await this.db
      .select({ id: users.id, deletedAt: users.deletedAt, kind: users.kind })
      .from(users)
      .where(
        and(
          eq(users.environmentId, this.environmentId),
          eq(users.externalId, externalId),
        ),
      )
      .limit(1);

    // A KIND CHANGE IS REPORTED, NOT PERFORMED (chapter 3.17, FR-002a, FR-002d).
    //
    // `person -> bot` is allowed when the row has NEVER SENT A MESSAGE. Without that
    // escape the natural ordering traps a customer: `POST /v1/channels/:id/members`
    // creates any unknown identifier as a person, because `createUser` cannot set
    // `kind` — so "add support-bot to #support" followed by "register support-bot as a
    // bot" would make that bot permanently impossible. The escape closes at the first
    // message, because a message already attributed to a person must not turn into one
    // attributed to software.
    //
    // `bot -> person` is refused unconditionally. A bot's messages are attributed to it
    // and demoting it would rewrite what those messages mean, retroactively.
    //
    // THE COST IS A FILTERED SCAN. `messages.user_id` carries no index and this asks
    // whether one row exists, so `LIMIT 1` is doing the work: the planner stops at the
    // first hit rather than counting. Measured in `baseline.txt` (T018b) rather than
    // assumed, and no index was added for a question asked once per promotion.
    // A THIRD THROW OF THE SAME CLASS IS WHAT THE RATCHET CAUGHT, AND DELETING IT IS THE
    // FIX (chapter 3.17). The first version of this branch read the row back and threw if
    // it was absent, then returned `kind_conflict` — which is the second statement for one
    // impossible state that the comment forty lines below already argues against. Lines
    // fell to **98.95%** against a pin of 99 and the gate went red, exactly as that
    // comment predicts. Third time this project has answered the ratchet by removing code
    // rather than covering it (3.12's `addMember`, 3.16's `upsertUser`).
    //
    // The flag defers to the read the method already does at the end, so the conflict
    // costs no extra query and no extra throw.
    let kindConflict = false;
    if (before !== undefined && profile.kind !== undefined && profile.kind !== before.kind) {
      const promotable =
        before.kind === "person" &&
        profile.kind === "bot" &&
        (
          await this.db
            .select({ id: messages.id })
            .from(messages)
            .where(eq(messages.userId, before.id))
            .limit(1)
        ).length === 0;
      kindConflict = !promotable;
    }

    if (before !== undefined && !kindConflict) {
      await this.db
        .update(users)
        .set({
          // Absent stays absent, exactly as the single PATCH treats it — except
          // `deleted_at`, which a revival always clears.
          ...(profile.display_name === undefined
            ? {}
            : { displayName: profile.display_name }),
          ...(profile.avatar_url === undefined ? {} : { avatarUrl: profile.avatar_url }),
          ...(profile.metadata === undefined ? {} : { metadata: profile.metadata }),
          // ABSENT STAYS ABSENT FOR `kind` TOO (T019a). An entry that omits it is not
          // asking for `'person'`; the column default is for new rows only.
          ...(profile.kind === undefined ? {} : { kind: profile.kind }),
          ...(profile.description === undefined
            ? {}
            : { description: profile.description }),
          deletedAt: null,
        })
        .where(and(eq(users.id, before.id), eq(users.environmentId, this.environmentId)));
    }

    const after = await this.getUserByExternalId(externalId);
    if (after === null) throw new Error(`user ${externalId} could not be created or read`);
    return {
      user: after,
      status: kindConflict
        ? "kind_conflict"
        : before?.deletedAt != null
          ? "revived"
          : "updated",
    };
  }

  /** Ban and unban a user, tenant-wide (chapter 3.15, FR-031, FR-032).
   *
   * TENANT-SCOPED AND NOT A REMOVAL. A ban stops the user connecting and sending
   * anywhere in the environment; it takes no membership away and hides no history. So
   * banning a member of a private channel leaves them a member — the channel's other
   * members still see their messages, and lifting the ban restores everything without
   * anybody being re-added. `deleteUser` is the operation that removes memberships, and
   * these two are deliberately not it.
   *
   * IDEMPOTENT, both directions, and neither reports which happened. Unlike the deletion,
   * nothing downstream needs to tell "banned now" from "was already banned": the route
   * answers 200 either way because the caller's intent — this user must not connect — is
   * satisfied either way.
   *
   * `banned_at` HAD NO WRITER, the same omission `channels.archived_at` had. The column
   * has been in the schema since chapter 2.1 with zero references outside tests. */
  /** Chapter 3.20. A BAN WRITES ONE `channel.member_removed` PER CHANNEL, and the
   * task list said "one event for the user, not one per channel" until this method
   * was written and the question turned out to have no such answer.
   *
   * **FR-WHK-02 names no event type for a ban.** Its eight are `message.created`,
   * `message.updated`, `message.deleted`, `channel.created`, `channel.member_added`,
   * `channel.member_removed`, `user.connected` and `user.disconnected`, and inventing
   * a ninth is scope this chapter does not have — the spelling belongs to the clause
   * and a customer's subscription filters on it.
   *
   * So the choice was: no durable record at all, or the removals a ban actually is.
   * No record makes the Redis publish beside it publish-after-commit with nothing in
   * the outbox, which is the case constitution II names by name. **A ban IS a removal
   * from every channel** — a consumer subscribed to `channel.member_removed` wants to
   * know, and would be wrong to learn about it only for administrative removals.
   *
   * THE FABRIC PUBLISH IS STILL ONE, and `specs/038-chapter-3-20/data-model.md` §5's
   * "once per user, not once per channel" is about that publish rather than about
   * these rows. The two were the same sentence in that document and are not the same
   * thing; the row count is bounded by FR-CHN-07's thousand members per channel.
   *
   * The returned list is the channels the ban revoked — the caller needs it for the
   * fabric publish, and reading it inside the transaction is what makes the rows and
   * the flag agree. */
  async banUser(userId: string): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const banned = await tx
        .update(users)
        .set({ bannedAt: new Date() })
        .where(
          and(
            eq(users.id, userId),
            eq(users.environmentId, this.environmentId),
            isNull(users.bannedAt),
          ),
        )
        .returning({ externalId: users.externalId });

      // ONLY WHEN A ROW WAS UPDATED. `isNull(users.bannedAt)` already makes a re-ban
      // touch nothing, so without this guard every repeated ban would emit a full set
      // of events for a state that did not change (FR-005).
      if (banned.length === 0) return [];
      const externalId = banned[0]!.externalId;

      const channelRows = await tx
        .select({ channelId: members.channelId })
        .from(members)
        .where(eq(members.userId, userId));

      const occurredAt = new Date().toISOString();
      for (const { channelId } of channelRows) {
        const event = membershipEvent({
          eventId: randomUUID(),
          environmentId: this.environmentId,
          change: "removed",
          occurredAt,
          membership: { channel_id: channelId, user: externalId },
        });
        await tx.insert(outbox).values({
          subject: event.subject,
          payload: event.payload,
        });
      }
      return channelRows.map((r) => r.channelId);
    });
  }

  async unbanUser(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ bannedAt: null })
      .where(
        and(eq(users.id, userId), eq(users.environmentId, this.environmentId)),
      );
  }

  /** Delete a user, keeping the row (chapter 3.15, FR-027, FR-028, FR-029).
   *
   * WHAT GOES: the profile fields, the memberships, the read positions.
   * WHAT STAYS: the row, the messages, and every `usage_active_users` row.
   *
   * THE ROW IS THE WHOLE ARGUMENT. `ON DELETE SET NULL` on `messages.user_id` satisfies
   * the letter of "messages are preserved" and breaks delivery:
   * `backfill.controller`'s `toFrame` drops a senderless row, so every message the user
   * ever sent would silently disappear from every reconnecting client. "Authored by a
   * deleted user" and "authored by nobody" are different states and only one of them is
   * FR-028.
   *
   * `usage_active_users` IS UNTOUCHED (FR-029). Billing history does not vanish with a
   * profile — a customer who deleted a user in March still owes for March.
   *
   * MEMBERSHIPS AND READ POSITIONS GO TOGETHER, and the read position goes because the
   * membership does: a position is per-member state keyed by channel and user, so keeping
   * it would leave a row pointing at a membership that no longer exists. It is the same
   * deletion the member-removal path already performs.
   *
   * IDEMPOTENT, and it reports which happened, so the route can answer 200 twice while a
   * user who never existed still gets 404. */
  async deleteUser(userId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [alive] = await tx
        .select({ id: users.id, deletedAt: users.deletedAt })
        .from(users)
        .where(
          and(eq(users.id, userId), eq(users.environmentId, this.environmentId)),
        )
        .limit(1);
      if (alive === undefined) return false;

      await tx.delete(readPositions).where(eq(readPositions.userId, userId));
      await tx.delete(members).where(eq(members.userId, userId));
      // `description` IS NOT IN THIS `set`, AND ITS ABSENCE IS THE REQUIREMENT
      // (chapter 3.17, FR-004a, T043b).
      //
      // FR-027 clears profile data on deletion, and a bot's description is not profile
      // data — it says what the software is, which is what makes the messages it already
      // sent answerable after it is gone. Clearing it would violate
      // `users_bot_description_check` and make a bot **the one kind of user that cannot
      // be deleted**: the constraint would reject the deletion itself.
      //
      // The rejected alternative was clearing `kind` back to `'person'` first. That
      // makes the deletion two writes and leaves a person nobody created, holding
      // messages a bot sent.
      //
      // THE OTHER DELETION METHOD IS `markUserDeleted`, and it clears nothing — it only
      // stamps the marker. It has **no production caller**: chapter 3.16 added it so the
      // listing's 404 branch was reachable before the deletion route existed. This rule
      // is `deleteUser`'s, and a reader looking for it in the other one will find a
      // method nothing calls.
      await tx
        .update(users)
        .set({
          displayName: null,
          avatarUrl: null,
          metadata: {},
          deletedAt: alive.deletedAt ?? new Date(),
        })
        .where(eq(users.id, userId));
      return true;
    });
  }

  /** Write a user's profile (chapter 3.15, FR-023, FR-024).
   *
   * THE FIRST WRITER `users.avatar_url` AND `users.metadata` HAVE EVER HAD. Both columns
   * have been in the schema since chapter 2.1 with zero references outside tests — two of
   * the four columns this feature was specified to give readers, and giving them a reader
   * meant giving them a writer first.
   *
   * PARTIAL BY CONSTRUCTION, and `undefined` is not `null`. A field absent from the patch
   * is absent from the `set`, so it keeps its value; a field present and null is written
   * null, which clears it. `exactOptionalPropertyTypes` makes the two distinguishable in
   * the type rather than by convention (ADR-15's strictness).
   *
   * AN EMPTY PATCH DOES NOT ISSUE AN UPDATE. Drizzle throws on a `set` with no columns,
   * and issuing `SET` with nothing to set would be a write that means nothing anyway. The
   * caller gets the current row, which is the honest answer to a request that asked for no
   * change.
   *
   * SCOPED AND ALIVE. The `where` carries the environment and `deleted_at IS NULL`: a
   * deleted user's profile is not editable, and the route above answers 404 for the same
   * reason. Returning null is how the caller tells "no such user" from "wrote nothing". */
  async updateUserProfile(
    userId: string,
    patch: {
      display_name?: string | null | undefined;
      avatar_url?: string | null | undefined;
      metadata?: Record<string, unknown> | undefined;
      /** Chapter 3.17, FR-004. `string | undefined` and NOT `| null`, unlike its three
       * neighbours: the boundary refuses a null (FR-004b) because
       * `users_bot_description_check` would raise on a bot, so a null can never arrive
       * here and widening the type would invite one. */
      description?: string | undefined;
    },
  ): Promise<UserRow | null> {
    const set: Record<string, unknown> = {};
    if (patch.display_name !== undefined) set["displayName"] = patch.display_name;
    if (patch.avatar_url !== undefined) set["avatarUrl"] = patch.avatar_url;
    if (patch.metadata !== undefined) set["metadata"] = patch.metadata;
    if (patch.description !== undefined) set["description"] = patch.description;

    if (Object.keys(set).length > 0) {
      const updated = await this.db
        .update(users)
        .set(set)
        .where(
          and(
            eq(users.id, userId),
            eq(users.environmentId, this.environmentId),
            isNull(users.deletedAt),
          ),
        )
        .returning({ externalId: users.externalId });
      if (updated.length === 0) return null;
      return this.getUserByExternalId(updated[0]!.externalId);
    }

    const [row] = await this.db
      .select({ externalId: users.externalId })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.environmentId, this.environmentId),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    return row === undefined ? null : this.getUserByExternalId(row.externalId);
  }

  /** Record a read position (chapter 3.15, FR-017, FR-018).
   *
   * FORWARDS ONLY, and the clamp is in SQL rather than in a read-then-write. `greatest`
   * on the conflict target means a replayed acknowledgement from a client that fell
   * behind is a 200 that changes nothing, and two concurrent writes cannot lose the
   * higher one — a read followed by a write would, whichever order they interleave.
   *
   * PAST THE END IS REFUSED (FR-018). A position beyond `channels.last_sequence` makes
   * every count derived from it wrong for every message that arrives afterwards, and it
   * cannot come from a client that has actually read anything. `null` is how the caller
   * learns to answer 400; the alternative — clamping silently — would accept a client
   * bug and hide it.
   *
   * THE SEQUENCE IS READ IN THE SAME TRANSACTION as the upsert, so the bound cannot
   * move between the check and the write. It can only move UP, so a racing send makes
   * the check conservative rather than wrong. */
  async setReadPosition(
    channelId: string,
    userId: string,
    sequence: number,
  ): Promise<{ sequence: number } | null> {
    return this.db.transaction(async (tx) => {
      const [channel] = await tx
        .select({ lastSequence: channels.lastSequence })
        .from(channels)
        .where(
          and(eq(channels.id, channelId), eq(channels.environmentId, this.environmentId)),
        )
        .limit(1);
      if (channel === undefined || sequence > channel.lastSequence) return null;

      const [row] = await tx
        .insert(readPositions)
        .values({
          environmentId: this.environmentId,
          channelId,
          userId,
          sequence,
        })
        .onConflictDoUpdate({
          target: [readPositions.channelId, readPositions.userId],
          set: {
            sequence: sql`greatest(${readPositions.sequence}, excluded.sequence)`,
            updatedAt: new Date(),
          },
        })
        .returning({ sequence: readPositions.sequence });
      return row ?? null;
    });
  }

  /** Mark a user deleted, keeping the row (chapter 3.15, FR-017).
   *
   * THE ROW SURVIVES ON PURPOSE. `ON DELETE SET NULL` on `messages.user_id` would
   * satisfy "messages are preserved" and break delivery: `toFrame` drops a senderless
   * row from a resume, so a deleted author would silently remove their messages from
   * every reconnecting client. The marker keeps authorship and removes the user from
   * the API.
   *
   * IDEMPOTENT, and it reports which happened. Deleting a user twice is not an error —
   * a customer's retry after a timeout is the ordinary case — but the caller still has
   * to be able to answer 404 the second time, and `false` is how it knows.
   *
   * The deletion route is this method's production caller and arrives in a later
   * phase. It exists now because the listing has to answer 404 for a deleted user,
   * and a 404 branch with no way to reach it is a branch no test can cover. */
  async markUserDeleted(userId: string): Promise<boolean> {
    const updated = await this.db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(users.id, userId),
          eq(users.environmentId, this.environmentId),
          isNull(users.deletedAt),
        ),
      )
      .returning({ id: users.id });
    return updated.length > 0;
  }

  /** A user's channels, most recently active first, keyset-paginated (chapter
   * 3.15, FR-013, FR-CHN-08).
   *
   * `id` IS PART OF THE KEY AND NOT DECORATION. `last_activity_at` is not unique:
   * two channels can take a message in the same millisecond, and a keyset on a
   * non-unique column either skips a row or repeats one at every page boundary
   * where a tie straddles it. Postgres row comparison — `(a, b) < (x, y)` — gives
   * the strict lexicographic "everything after this exact row" the cursor means,
   * in one predicate the planner can drive an index with.
   *
   * MEMBERSHIP IS THE JOIN, NOT A FILTER AFTER THE FACT (FR-015). The listing set
   * is the membership set: `members_user_channel` is an index on
   * `(user_id, channel_id)`, so the join drives from the user's own rows and a
   * channel they are not in is never a candidate. A public channel they could read
   * by id does not appear here — the read set and the subscription set are
   * deliberately different sets, and the chapter says so.
   *
   * ARCHIVED CHANNELS APPEAR, with `archived_at` on the row (FR-022). A customer
   * who archived a channel still has to be able to find it, and hiding it here
   * would make the archive a delete.
   *
   * SCOPED THROUGH `users`, the way `channelsForUser` is: `members` carries no
   * `environment_id` of its own (it is a hop table, two links from a tenant), so
   * the scope is asserted on the parent that has one. */
  async listChannelsForUser(
    userId: string,
    { limit, after }: { limit: number; after?: { activityAt: Date; id: string } },
  ): Promise<{
    rows: Array<{
      id: string;
      external_id: string;
      type: ChannelRow["type"];
      name: string | null;
      role: string;
      archived_at: string | null;
      last_activity_at: string;
      last_sequence: number;
      unread: number;
      last_message: {
        sequence: number;
        text: string | null;
        user: { id: string } | null;
        created_at: string;
      } | null;
    }>;
    nextCursor: { activityAt: Date; id: string } | null;
  }> {
    // ONE ROW MORE THAN ASKED FOR, which is how the caller learns whether there is
    // a next page without a second count query. The extra row is dropped before
    // returning and its predecessor becomes the cursor.
    const rows = await this.db
      .select({
        id: channels.id,
        externalId: channels.externalId,
        type: sql<ChannelRow["type"]>`${channels.type}`,
        name: channels.name,
        role: members.role,
        archivedAt: channels.archivedAt,
        lastActivityAt: channels.lastActivityAt,
        lastSequence: channels.lastSequence,
        // THE UNREAD COUNT, WITH NO COUNTER (FR-016). `channels.last_sequence` has been
        // the sequencing authority since chapter 2.2 and the write path maintains it, so
        // this has nothing to invalidate and nothing to backfill. Measured for one page
        // of 50 channels against 1,000,000 messages: counting rows past the position is
        // 9.8-13.4 ms, a cached counter is 1.2-2.1 ms, and this subtraction is
        // 1.1-4.5 ms. The counter is no faster and adds a value that can go stale.
        //
        // `greatest(..., 0)` is defence against a bug, not a reachable state: a position
        // is refused past `last_sequence` when it is written and `last_sequence` never
        // goes backwards. It costs nothing and turns a negative count into zero rather
        // than into a client bug report. `repository.itest.ts` plants a position above
        // the end to cover the arm, because nothing else can reach it.
        //
        // A MISSING ROW IS POSITION ZERO (FR-017a). `coalesce` on the left join, not a
        // seeded row on join: a new member's unread count is the channel's whole
        // history, which is the same answer a re-added member gets, because removal
        // deleted their position with their membership.
        unread: sql<number>`greatest(${channels.lastSequence} - coalesce(${readPositions.sequence}, 0), 0)`,
        // THE LAST MESSAGE, AND A TOMBSTONE IS STILL THE LAST MESSAGE (FR-019).
        //
        // The row AT `last_sequence`, reported with `text: null` when it is a tombstone,
        // rather than walking back to the last row that still has text. The walk-back is
        // a second query per channel and it would disagree with the count beside it,
        // which counts the tombstone because the sequence is kept. One rule for both
        // fields. A client that wants a preview renders "message deleted" from the null.
        //
        // A LATERAL SUBQUERY AND NOT A JOIN, because `messages_channel_id_sequence_unique`
        // makes this an index lookup per row of an already-bounded page — 26 lookups, not
        // a join against the whole message table. A join would also have to carry the
        // ordering, and the planner would have to be talked out of sorting messages.
        lastMessage: sql<{
          sequence: number;
          text: string | null;
          user_external_id: string | null;
          created_at: string;
        } | null>`(
          select json_build_object(
            'sequence', m.sequence,
            'text', m.text,
            'user_external_id', mu.external_id,
            'created_at', m.created_at
          )
            from messages m
            left join users mu on mu.id = m.user_id
           where m.channel_id = ${channels.id} and m.sequence = ${channels.lastSequence}
        )`,
      })
      .from(members)
      .innerJoin(channels, eq(channels.id, members.channelId))
      .innerJoin(users, eq(users.id, members.userId))
      .leftJoin(
        readPositions,
        and(
          eq(readPositions.channelId, members.channelId),
          eq(readPositions.userId, members.userId),
        ),
      )
      .where(
        and(
          eq(members.userId, userId),
          eq(users.environmentId, this.environmentId),
          eq(channels.environmentId, this.environmentId),
          after === undefined
            ? undefined
            : sql`(${channels.lastActivityAt}, ${channels.id}) < (${after.activityAt}, ${after.id})`,
        ),
      )
      .orderBy(desc(channels.lastActivityAt), desc(channels.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page.map((r) => ({
        id: r.id,
        external_id: r.externalId,
        type: r.type,
        name: r.name,
        role: r.role,
        archived_at: r.archivedAt === null ? null : toIso(r.archivedAt),
        last_activity_at: toIso(r.lastActivityAt),
        last_sequence: r.lastSequence,
        unread: Number(r.unread),
        // `null` when the channel has never had a message: `last_sequence` is 0 and no
        // row carries sequence 0, so the subquery finds nothing. Distinct from a
        // tombstone, which IS a row and reports itself with a null text.
        last_message:
          r.lastMessage === null
            ? null
            : {
                sequence: Number(r.lastMessage.sequence),
                text: r.lastMessage.text,
                user:
                  r.lastMessage.user_external_id === null
                    ? null
                    : { id: r.lastMessage.user_external_id },
                created_at: r.lastMessage.created_at,
              },
      })),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { activityAt: last.lastActivityAt, id: last.id }
          : null,
    };
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
      attachments,
      idempotencyKey,
      senderMustBeBot = false,
    }: {
      /** THE SENDER MUST BE A BOT (chapter 3.17, FR-007, T030, T032).
       *
       * A CONSTRAINT, NOT A CREDENTIAL CLASS. Research R5 says the repository must not
       * learn what a credential is, and it does not: it is told that this send's sender
       * has to be software, and the controller is the only thing that knows an
       * application key is why.
       *
       * IT LIVES HERE BECAUSE OF THE ORDER, and the order was the finding. The
       * documented sequence (`contracts/sending.md`) puts "may this credential send as
       * that sender?" last, after the channel checks, so that a refusal naming a fact
       * about a user cannot be provoked for a channel the caller could not otherwise
       * reach. Enforcing it in the service would put it FIRST — before the ban, the
       * visibility and the archive — and leak exactly what the ordering protects.
       * There is no way to be both last and outside this transaction. */
      /** FR-001 and FR-006. Optional in, and the column stores `NULL` rather than `[]`
       * when there are none — `data-model.md` says why the two differ: NULL means the
       * message has no attachments, and `[]` would be a list that happens to be empty.
       * Every read converts NULL to `[]` on the way out (FR-007), once. */
      attachments?: Attachment[] | undefined;
      senderMustBeBot?: boolean;
      /** REQUIRED SINCE CHAPTER 3.17 (FR-MSG-15, FR-006), and required is the whole
       * mechanism. SC-003 asks that no write path be able to produce a senderless
       * message; a runtime check would be a test somebody has to remember, and this
       * is a compile error. `exactOptionalPropertyTypes` means a caller cannot pass
       * `undefined` here either — passing a `string | undefined` is named by the
       * compiler, not silently accepted.
       *
       * There is no red test for this. Reverting the `?` is what makes the guarantee
       * visible, and the transcript of that revert is SC-003a's evidence (T013a). */
      userId: string;
      /** Chapter 3.3: the sender as a CONSUMER will see them. Threaded from the
       * caller rather than looked up here — the internal route already holds it
       * (it is the token's subject), and an extra SELECT inside the write
       * transaction is a cost every message would pay forever.
       *
       * STILL OPTIONAL, and that is not an oversight. `userId` is what the platform
       * stores and `userExternalId` is what a consumer sees; the public route now
       * resolves a bot and holds both, but the internal route has always supplied
       * both and nothing requires a caller to know the external id to write a row. */
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

      // ── THE BAN, FIRST, AND AHEAD OF THE CHANNEL READ (FR-031, FR-021a) ─────
      //
      // T072 left this slot and only Phase 15 can fill it, because until now nothing
      // wrote `banned_at`. The position is the requirement: **before the channel is
      // resolved**, so a banned user gets one answer for every channel id — real,
      // foreign or invented. Put it after the channel read and the refusal for a
      // channel that exists differs from the refusal for one that does not, and a
      // banned user can enumerate channel ids.
      //
      // EVERY SEND IS ATTRIBUTED NOW (chapter 3.17, FR-MSG-15). The gate that used to
      // stand here — `if (userId !== undefined)` — guarded against a key-authenticated
      // send that carried no user, and `userId` is required as of this chapter, so the
      // condition could no longer be false. **Fourth time this project has met a guard
      // that stopped meaning anything**: `addMember`'s `rowCount ?? 0` (3.12), and
      // `upsertUser`'s second throw and `(row.metadata ?? {})` (3.16). Tightening a
      // type makes its runtime guards dead; three of the seven `userId` comparisons in
      // this file were dead the moment T012 landed, and two others are in methods where
      // the parameter is optional by design and must not be touched.
      //
      // A BOT CAN BE BANNED, AND THAT IS THE POINT (FR-005c). `banned_at` has been on
      // every `users` row since chapter 3.15 and this check has never run for a bot
      // because no send named one. A ban is how an operator stops a runaway integration
      // without deleting the identity its messages are attributed to.
      //
      // ONE LOOKUP, TWO ANSWERS. `kind` is read here and used again at the private
      // channel check below (FR-019a). The alternative is a second SELECT on the write
      // path for every message forever, to learn something this query already touched.
      const [sender] = await tx
        .select({ bannedAt: users.bannedAt, kind: users.kind })
        .from(users)
        .where(
          and(eq(users.id, userId), eq(users.environmentId, this.environmentId)),
        )
        .limit(1);
      if (sender?.bannedAt != null) throw new UserBannedError(userId);
      const senderIsPerson = sender?.kind !== "bot";

      const [channel] = await tx
        .select({
          id: channels.id,
          lastSequence: channels.lastSequence,
          // Chapter 3.15. `channels.type` has been a `"public" | "private"` column
          // with a CHECK since chapter 2.1 and nothing decided on it until now — it
          // was returned by the create route and consulted by nothing.
          type: channels.type,
          // Chapter 3.15. Declared in chapter 2.1 and read by NOTHING until here:
          // zero non-test references, measured rather than assumed (T007).
          archivedAt: channels.archivedAt,
        })
        .from(channels)
        .where(
          and(
            eq(channels.id, channelId),
            eq(channels.environmentId, this.environmentId),
          ),
        )
        .for("update");
      if (!channel) throw new ChannelNotFoundError(channelId);

      // MEMBERSHIP, FOR A PRIVATE CHANNEL, WHEN A USER IS SENDING (chapter 3.15,
      // FR-001, FR-CHN-05).
      //
      // HERE AND NOT IN A HANDLER, because constitution I says isolation is
      // enforced in data access. Two controllers reach this function and neither
      // can be trusted to remember a rule the other also needs.
      //
      // GATED ON `userId`, and the parameter is the whole distinction:
      //
      //     userId present    a USER is sending. Membership applies.
      //     userId absent     the TENANT is sending through an application key.
      //                       It acts for the customer, carries no user, and sees
      //                       private channels (FR-005).
      //
      // And that gate is only honest because chapter 3.15 made the public route
      // supply a user. It called `messages.send(channelId, body)` with none, and
      // `MessagesController` declared no `@Accepts` at the time — so the guard fell
      // back to `EITHER` and a user token was accepted there. Chapter 3.17 declared it;
      // the third of three copies of this sentence, all corrected in 3.23. A check gated on a parameter
      // no caller fills in is a check that never fires, and this one did not, on
      // the only send path a customer's own client uses.
      //
      // `ChannelNotFoundError` AND NOT A 403. SC-002 requires the answer for a
      // private channel the caller cannot see to be byte-identical to a channel
      // that does not exist — same status, same body but for `request_id` — and
      // send is one of the verbs it covers. A `403 not_a_member` here would
      // announce that the channel exists, which is the leak FR-003 forbids and
      // exactly what chapter 3.12's indistinguishability oracle was built to
      // catch. The refusal above throws the same error for the same reason.
      //
      // FR-021a's ORDER is ban, then membership and visibility, then archive. The
      // ban goes ahead of the channel read entirely, so a banned user gets one
      // answer for every channel id; the archive check goes below this one, so a
      // non-member of a private archived channel never learns it exists from
      // `channel_archived`. Both arrive with their own columns' chapters; this is
      // the middle of the three.
      // THE SENDER ATTRIBUTES; IT DOES NOT AUTHORISE (chapter 3.17, FR-019).
      //
      // This gate used to read `channel.type === "private" && userId !== undefined`,
      // and the second half was doing real work: a key-authenticated send carried no
      // user, so it skipped the membership check entirely. That is chapter 3.15's
      // FR-005 — an application credential "acts for the customer, carries no user,
      // and sees private channels" — and `messages.itest.ts` asserts it by name.
      //
      // Requiring `userId` would have made the condition always true, fired the check,
      // and refused a bot that is not a member with `ChannelNotFoundError`: a 404 that
      // by design cannot say why. A capability chapter 3.15 delivered would have
      // vanished, and the analysis passes that read FR-005 never noticed because the
      // word "private" appeared nowhere in this chapter's plan.
      //
      // So the gate turns on WHAT THE SENDER IS, not on whether there is one. A key
      // naming a bot has exactly the authority the key has today; the bot's name is
      // what appears on the message and nothing more. A person's token still both
      // authorises and attributes, which is why `senderIsPerson` is the condition and
      // a person who is not a member is still refused, indistinguishably (FR-019b).
      if (channel.type === "private" && senderIsPerson) {
        const [membership] = await tx
          .select({ userId: members.userId })
          .from(members)
          .where(and(eq(members.channelId, channelId), eq(members.userId, userId)))
          .limit(1);
        if (!membership) throw new ChannelNotFoundError(channelId);
      }

      // THE SENDER'S KIND, LAST OF THE FIVE (chapter 3.17, FR-007, T032).
      //
      // After the ban, the visibility and the archive, because this refusal names a
      // fact about a USER — "that identifier is a person" — and a caller who could not
      // otherwise reach this channel must not be able to ask it. Same reasoning as
      // archive-after-visibility three checks below, one subject over.
      //
      // `senderIsPerson` was computed at the ban check from the same row, so this costs
      // nothing beyond the comparison.
      if (senderMustBeBot && senderIsPerson) {
        throw new SenderNotPermittedError(userId);
      }

      // ARCHIVE, AFTER VISIBILITY AND NOT BEFORE (chapter 3.15, FR-020, FR-021,
      // FR-021a).
      //
      // The order is the requirement, not an implementation detail. Put this check
      // above the membership one and a non-member of a private ARCHIVED channel
      // learns it exists from `channel_archived` — a refusal that reveals what it is
      // refusing, which is the defect chapter 3.12's fifth analysis pass caught one
      // phase before shipping.
      //
      // So: ban, then membership and visibility, then archive. The ban's slot is
      // ahead of the channel read entirely — a banned user gets one answer for every
      // channel id, including ids that do not exist — and it is EMPTY here on
      // purpose: `users.banned_at` has no reader until chapter 3.16 gives it one at
      // T155a. Leaving the slot visible is the point; a reader who finds two checks
      // where the requirement names three should be able to see which is missing.
      //
      // History stays readable while archived (FR-020). Only the write refuses.
      if (channel.archivedAt !== null) throw new ChannelArchivedError(channelId);

      // THE CAP, CHECKED BEFORE THE MESSAGE IS WRITTEN (chapter 3.10, FR-RTL-08).
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
      const quota = await this.assertWithinQuota(tx, period, userId, senderIsPerson);

      const seq = channel.lastSequence + 1;
      const id = randomUUID();

      const insert = tx.insert(messages).values({
        id,
        channelId: channel.id,
        sequence: seq,
        userId: userId ?? null,
        text,
        metadata: metadata ?? {},
        // THE ARRAY AS SENT, IN ORDER (FR-006), or NULL when there are none. JSONB
        // preserves array order, so nothing here sorts or de-duplicates: FR-021 says
        // the same URL twice is two attachments.
        //
        // `?? null` AND NOT `?? []`. An empty array stored would be a message that
        // carries a list of no attachments, which is a different fact from carrying
        // none — and `listMessages`' own `?? []` makes both read identically anyway.
        attachments: attachments ?? null,
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
      //
      // AND `lastActivityAt` MOVES IN THE SAME STATEMENT (chapter 3.15, FR-014).
      // The listing orders a user's channels by their most recent activity, and
      // FR-014's answer to what that means is: a message. Not a join, not a
      // rename, not an archive — a column that moved for those would order by
      // something its own name does not say, which is what T108 tests.
      //
      // ONE STATEMENT AND NO NEW TRANSACTION. The write path already updates this
      // row here, so the column costs an extra assignment rather than an extra
      // round trip. It also lands on the INSERTED branch only, beside the
      // sequence: a recognised idempotent retry returned above without reaching
      // this line, which is the behaviour the ordering wants — a duplicate send
      // is not new activity.
      //
      // `createdAt` FROM THE ROW, NOT `now()`. The message carries a timestamp
      // the database assigned; reading the clock a second time here would let the
      // ordering key and the message it orders by disagree by microseconds, and
      // the cursor is keyed on this column.
      await tx
        .update(channels)
        .set({ lastSequence: seq, lastActivityAt: inserted[0]!.createdAt })
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
      // window of over-service, a flush here costs the month (a quota must survive the counter store).
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
      // EVERY SEND IS ATTRIBUTED, SO EVERY SEND COUNTS (chapter 3.17). The gate here
      // was the twin of the ban check's: it existed because a key-authenticated send
      // carried no `userId`, which chapter 3.3 decided and FR-MSG-15 reverses.
      //
      // A BOT IS BILLED (FR-018, FR-ANL-05, *"shall meter, per tenant per day:
      // messages sent, unique active users, ..."*). The row is the bill, and a bot's
      // send writes one like anyone's. What a bot is exempt from is the ENFORCED
      // ceiling in `assertWithinQuota` — FR-RTL-05, narrowed to "unique active
      // persons" by this chapter's amendment. Metering and enforcement were already
      // two clauses in two families; this insert is the first one.
      await tx
        .insert(usageActiveUsers)
        .values({ environmentId: this.environmentId, period, userId })
        .onConflictDoNothing();

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
        // ONLY THE `userId` HALF WAS DEAD. `userRef !== null` still decides whether a
        // user cap exists at all, and asking the database for a count when no cap is
        // configured is a query nobody reads.
        const mayHaveAddedUser = userRef !== null;

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
        // `[]` UNTIL PHASE 4 WRITES THE INSERT. True today rather than a placeholder:
        // no send body accepts attachments yet, so there is nothing to carry.
        attachments: [],
        created_at: createdAt,
      };
    });
  }

  /** Change what a message says (chapter 3.23, FR-001, FR-002, FR-003, FR-004).
   *
   * ONE TRANSACTION, AND THE HISTORY ROW IS WHY. FR-004 wants the superseded text
   * appended for every edit; a row updated in one statement and a history appended in
   * another can crash between them, and the surviving state is a message whose old text
   * nobody has. The pair commits or neither does.
   *
   * WHAT IS NOT IN THE `SET` LIST, and this is FR-002 stated as code rather than as a
   * comment: `sequence`, `channelId`, `userId` and `createdAt` are absent. A test can
   * only assert the values are unchanged (T027) — a thing not done leaves no trace to
   * assert on — so the guarantee lives in the shape of this statement.
   *
   * AND `lastActivityAt` IS ABSENT TOO (FR-015). `sendMessage` moves it in the same
   * breath as the sequence, deliberately; an edit must not, because the listing orders
   * by "most recent activity" and FR-014's answer to what that means is a message.
   * Correcting a typo is not a new message. T035 falsifies it by adding the assignment
   * and watching T034 go red.
   *
   * THE ENVIRONMENT SCOPE IS HERE AND NOT ONLY IN THE SERVICE. `messages.service.ts`
   * asks `channelVisibleTo` first, the way `history` does, and that is the check that
   * produces FR-014's 404. This join carries `environmentId` anyway (constitution I): a
   * repository method that trusts its caller's check is one refactor from a leak, and
   * the two costs nothing to hold together because the read is on the primary key. */
  async editMessage(
    channelId: string,
    messageId: string,
    {
      text,
      /** WHO IS EDITING, and it is required (FR-013, FR-018). There is no
       * "the tenant is editing" convention here, unlike `sendMessage`'s optional
       * `userId`: FR-013a refuses an application credential outright, so an edit with
       * no user is not a case this method has to have an answer for. Required means the
       * compiler says so rather than a test having to remember. */
      userId,
    }: { text: string; userId: string },
  ): Promise<EditedMessageRow> {
    return this.db.transaction(async (tx) => {
      // THE ROW AND ITS CHANNEL IN ONE READ, joined so the tenant scope and the
      // channel-membership of the message are the same question. `messageId` alone
      // would edit a message of any channel of any tenant that guessed a uuid.
      const [row] = await tx
        .select({
          id: messages.id,
          userId: messages.userId,
          text: messages.text,
          seq: messages.sequence,
          createdAt: messages.createdAt,
          // The author as a CONSUMER sees them, for the outbox event below. Joined
          // here rather than looked up after the write: this transaction already
          // reads the row, and `MessageCreatedData`'s boundary is that `user_id` does
          // not cross it.
          author: users.externalId,
        })
        .from(messages)
        .innerJoin(channels, eq(channels.id, messages.channelId))
        // LEFT, like every other read of this table: a senderless row must still be
        // READ so FR-018 can refuse it by name rather than by looking absent.
        .leftJoin(users, eq(users.id, messages.userId))
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.channelId, channelId),
            eq(channels.environmentId, this.environmentId),
          ),
        )
        .limit(1);
      if (!row) throw new MessageNotFoundError(messageId);

      // AUTHORSHIP BEFORE THE TOMBSTONE CHECK, and the order is a disclosure decision
      // of the same family as FR-021a's. A stranger asking to edit a deleted message
      // must not learn from `message_deleted` that the message was ever there — they
      // are refused for not being the author, which is true of every message they did
      // not write, deleted or not. The author of a tombstone gets the specific answer.
      //
      // A NULL `userId` FAILS THIS, which is FR-018. `row.userId === null` cannot equal
      // any caller, so the comparison refuses it without a special case — and a special
      // case is what would let a future edit to this condition get it wrong.
      if (row.userId !== userId) throw new NotMessageAuthorError(messageId);
      if (row.text === null) throw new MessageDeletedError(messageId);

      // ONE CLOCK READING FOR BOTH WRITES. `edited_at` on the message and `edited_at`
      // on the history row are the same instant by construction; two `now()` calls
      // would be two instants, and the history row's own primary key is
      // (message_id, edited_at), so a caller reading the history could not match an
      // entry to the message state it produced.
      const [updated] = await tx
        .update(messages)
        .set({ text, editedAt: sql`now()` })
        .where(eq(messages.id, messageId))
        .returning({ editedAt: messages.editedAt });
      const editedAt = updated!.editedAt!;

      // FR-004. The row carries what the message said BEFORE this edit — `row.text`,
      // read above and narrowed to a string by the tombstone check.
      //
      // NO `onConflictDoNothing`. The primary key is (message_id, edited_at), so two
      // edits inside one microsecond collide, and a conflict clause here would silently
      // drop the second one's history while its text change committed. A loud failure
      // is the right answer to a state this table cannot represent — SAD §6.1 published
      // the key and `baseline.txt` records what it costs.
      await tx.insert(messageEdits).values({
        messageId,
        editedAt,
        priorText: row.text,
      });

      // THE EVENT COMMITS WITH THE EDIT (chapter 3.23, FR-019, ADR-06). Same argument
      // as the send path's and the deletion's: publishing after the commit leaves a
      // window where the row changed and the event never existed, silently, with
      // nothing to reconcile against.
      //
      // `occurred_at` IS THE EDIT'S INSTANT, not the message's `created_at` — an event
      // whose timestamp predates the previous event about the same message cannot be
      // ordered by a consumer. Read back from the UPDATE, so the event, the history
      // row's primary key and the wire frame all quote one instant.
      //
      // THE AUTHOR, FROM THE ROW. `editMessage`'s caller is the author by FR-013, so
      // `userExternalId` would be the same person — but reading it from the row is what
      // makes that a fact rather than an assumption, and `sendMessage` already threads
      // the same value for the creation event.
      const event = messageUpdatedEvent({
        eventId: randomUUID(),
        environmentId: this.environmentId,
        occurredAt: toIso(editedAt),
        message: {
          id: row.id,
          channel_id: channelId,
          seq: row.seq,
          user: row.author,
          text,
          created_at: toIso(row.createdAt),
        },
      });
      await tx.insert(outbox).values({
        subject: event.subject,
        payload: event.payload,
      });

      return {
        id: row.id,
        channel_id: channelId,
        seq: row.seq,
        text,
        // `[]` UNTIL PHASE 7 ADDS THE COLUMN TO THIS READ. An edit does not change
        // attachments (FR-016), and the `message.updated` event must carry the ones
        // the message already has — so this read gains the column with T046a rather
        // than staying as it is. **`traceability.md`'s T053 lists this read among the
        // four that "do not change", and after phase 7 that will be three.**
        attachments: [],
        created_at: toIso(row.createdAt),
        edited_at: toIso(editedAt),
        prior_text: row.text,
      };
    });
  }

  /** Turn a message into a tombstone (chapter 3.23, FR-006, FR-006a, FR-009).
   *
   * THE COLUMNS ARE `docs/05-sad.md:342`'s, verbatim: `text = NULL`,
   * `attachments = NULL`, `deleted_at = now()`. Everything else is untouched, and
   * `sequence` in particular — a tombstone that gave up its place would leave a gap in
   * every client's ordering and break every cursor keyed on it (FR-011).
   *
   * IDEMPOTENT BY A GUARD, NOT BY THE UPDATE (FR-009). Writing the three columns again
   * would be harmless for two of them and wrong for the third: `deleted_at = now()`
   * moves, and a client that had already read the tombstone would see its timestamp
   * change for no reason. So a row that is already a tombstone returns early — no write,
   * and no second outbox event, which is the half a pair of 204s cannot show.
   *
   * WHAT `alreadyDeleted` IS FOR. The caller has to know, because the controller must
   * not publish a second `message.deleted` to every connected member of the channel.
   * The status code is 204 either way; the fan-out is not.
   *
   * NO AUDIT LOG ROW, though SAD §342's diagram shows one beside the outbox insert.
   * There is no `audit_log` table in §6.1 or in `schema.ts`, and inventing one is a
   * feature with a retention policy rather than a line in this method. Chapter 3.23's
   * `gaps.md` item 2 draws that boundary: `metadata.deleted_by` records WHAT KIND of
   * principal deleted the message, and which credential it presented is the audit
   * log's question. */
  async deleteMessage(
    channelId: string,
    messageId: string,
    {
      /** Who is deleting, or `undefined` for an application credential (FR-012).
       *
       * OPTIONAL HERE AND REQUIRED ON THE EDIT, and the asymmetry is the requirement
       * rather than an inconsistency. FR-MOD-02 grants a tenant key deletion of any
       * message and is silent on editing; the spec reads silence as absence of
       * permission (FR-013a). So this route accepts both credential classes and the
       * edit accepts one.
       *
       * `undefined` MEANS THE TENANT, the convention `sendMessage` and `listMessages`
       * already use — and here it also skips the authorship check, which is what
       * FR-012 asks for. */
      userId,
      /** The deleter as a CUSTOMER sees them, for `metadata.deleted_by` (FR-006a).
       * Threaded rather than looked up, exactly as `sendMessage` threads its sender:
       * a SELECT inside the write transaction is a query every deletion would pay to
       * learn something the controller already holds. */
      userExternalId,
    }: { userId?: string; userExternalId?: string },
  ): Promise<{
    /** `user` IS NARROWED TO A STRING, unlike `MessageWithSender`'s.
     *
     * FR-018 refuses a row with no author before this method can return either branch,
     * so a tombstone this method produced always has one. The narrowing is here rather
     * than at the caller because this is where that argument lives — and the caller's
     * alternative was `deleted.user ?? "unknown"`, which is an uncovered arm and a lie
     * in the same expression. */
    deleted: MessageWithSender & { user: string; deleted_at: string };
    alreadyDeleted: boolean;
  }> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: messages.id,
          userId: messages.userId,
          text: messages.text,
          seq: messages.sequence,
          createdAt: messages.createdAt,
          deletedAt: messages.deletedAt,
          metadata: messages.metadata,
          author: users.externalId,
        })
        .from(messages)
        .innerJoin(channels, eq(channels.id, messages.channelId))
        // LEFT, like `listMessages`: an unattributed row must still be READ, or the
        // 121,250 senderless rows in the lane would be invisible to this method and a
        // deletion of one would look like a message that does not exist. FR-018 refuses
        // them below, deliberately and by name.
        .leftJoin(users, eq(users.id, messages.userId))
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.channelId, channelId),
            eq(channels.environmentId, this.environmentId),
          ),
        )
        .limit(1);
      if (!row) throw new MessageNotFoundError(messageId);

      // AUTHORSHIP, AND ONLY FOR A USER (FR-012, FR-013). `userId === undefined` is a
      // tenant key, which may delete anybody's message. A user may delete their own.
      //
      // FR-018 IS THE `row.userId === null` HALF and it applies to BOTH principals.
      // A row nobody wrote cannot be authorised against, and the requirement says
      // "an edit or deletion" — the deletion being the half a tenant key can reach,
      // which is why it is checked before the `userId === undefined` shortcut rather
      // than inside the user branch.
      if (row.userId === null) throw new NotMessageAuthorError(messageId);
      if (userId !== undefined && row.userId !== userId) {
        throw new NotMessageAuthorError(messageId);
      }
      // THE AUTHOR IS A STRING FROM HERE DOWN, and the foreign key is the argument.
      // `messages.user_id` references `users(id)`, and the check above established it is
      // not null — so the left join matched and `row.author` is that user's external id.
      // Asserted rather than defaulted: a `??` here would put a placeholder on the wire
      // as somebody's name, and the only state that could reach it is a violated
      // constraint, which should crash rather than publish.
      const author = row.author!;

      // ALREADY A TOMBSTONE: nothing to do, and nothing to announce.
      //
      // `text === null` IS THE TEST, not `deletedAt !== null`. Both are set together by
      // this method, but the lane holds rows where only `text` is null — system
      // messages have had no text since chapter 2.1 — and `text` is the column every
      // read path already branches on. Chapter 3.15's planted tombstone sets both.
      if (row.text === null) {
        return {
          deleted: {
            id: row.id,
            channel_id: channelId,
            seq: row.seq,
            text: null,
            created_at: toIso(row.createdAt),
            // `[]` AND IT STAYS `[]`. FR-012: deleting a message unlinks its
            // attachments, so a tombstone's list is empty on every path that
            // returns one. This is the answer, not a value a later phase fills.
            attachments: [],
            user: author,
            // THE INSTANT ALREADY ON THE ROW, not a fresh reading. FR-009 says a
            // repeated deletion changes nothing, and the timestamp is the column that
            // would otherwise move.
            //
            // `?? toIso(row.createdAt)` COVERS A ROW THE LANE ACTUALLY HOLDS: a system
            // message with a null text and no `deleted_at`, which has existed since
            // chapter 2.1. The branch above turns on `text`, deliberately, so such a
            // row reaches here — and it is already textless, so reporting its creation
            // instant is the honest answer rather than inventing a deletion time.
            deleted_at: row.deletedAt === null ? toIso(row.createdAt) : toIso(row.deletedAt),
          },
          alreadyDeleted: true,
        };
      }

      // WHO REMOVED IT (FR-006a). Merged into the existing metadata rather than
      // replacing it: the column is `jsonb NOT NULL DEFAULT '{}'` and this chapter is
      // its first writer anywhere in the platform, so every row carries `{}` today —
      // but a later chapter's key must not be erased by a deletion.
      //
      // TWO SHAPES, ONE KEY. `{ kind: "user", user }` or `{ kind: "application" }`,
      // because an application principal has no user of its own. The kind is always
      // recorded; the identifier exists only when there is one.
      const existing = (row.metadata ?? {}) as Record<string, unknown>;
      const deletedBy =
        userExternalId === undefined
          ? { kind: "application" as const }
          : { kind: "user" as const, user: userExternalId };

      const [updated] = await tx
        .update(messages)
        .set({
          text: null,
          attachments: null,
          deletedAt: sql`now()`,
          metadata: { ...existing, deleted_by: deletedBy },
        })
        .where(eq(messages.id, messageId))
        .returning({ deletedAt: messages.deletedAt });
      // Read back rather than recomputed: the row carries the instant the database
      // assigned, and the event and the frame must both quote that one.
      const deletedAt = toIso(updated!.deletedAt!);

      // THE EVENT COMMITS WITH THE TOMBSTONE (ADR-06), on the send path's argument at
      // its own outbox insert: publishing after the commit leaves a gap where the row
      // changed and the event never existed, silently, with nothing to reconcile.
      //
      // ON THIS BRANCH ONLY, which is FR-009's second half. A repeated deletion
      // returned above without writing, so it emits nothing — otherwise a client
      // retrying a 204 fires every subscribed webhook a second time.
      const event = messageDeletedEvent({
        eventId: randomUUID(),
        environmentId: this.environmentId,
        occurredAt: deletedAt,
        message: {
          id: row.id,
          channel_id: channelId,
          seq: row.seq,
          user: author,
          deleted_at: deletedAt,
        },
      });
      await tx.insert(outbox).values({
        subject: event.subject,
        payload: event.payload,
      });

      return {
        deleted: {
          id: row.id,
          channel_id: channelId,
          seq: row.seq,
          text: null,
          created_at: toIso(row.createdAt),
          // `[]` AND IT STAYS `[]`. FR-012: deleting a message unlinks its
          // attachments, so a tombstone's list is empty on every path that
          // returns one. This is the answer, not a value a later phase fills.
          attachments: [],
          user: author,
          // THE COMMITTED INSTANT, read back from the UPDATE. The outbox event above
          // quotes this same value, so a consumer and a socket client comparing the
          // event with the frame see one timestamp rather than two readings of one
          // clock a few milliseconds apart.
          deleted_at: deletedAt,
        },
        alreadyDeleted: false,
      };
    });
  }

  /** A message's edit history, oldest first (chapter 3.23, FR-023).
   *
   * SCOPED THE SAME WAY `editMessage` IS, through the join rather than through the
   * caller's promise. This read answers for a tenant API key (FR-023a refuses an end
   * user at the route), and a key is not a user — so there is no membership to check
   * and no `userId` parameter. What there IS is an environment, and it is on the join.
   *
   * `asc(editedAt)` AND NOT AN `id`. The table has no surrogate key, so insertion order
   * is not available to order by; `edited_at` is the ordering FR-023 asks for and the
   * primary key already indexes it. */
  async listMessageEdits(
    channelId: string,
    messageId: string,
  ): Promise<Array<{ prior_text: string; edited_at: string }>> {
    const rows = await this.db
      .select({
        priorText: messageEdits.priorText,
        editedAt: messageEdits.editedAt,
      })
      .from(messageEdits)
      .innerJoin(messages, eq(messages.id, messageEdits.messageId))
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(messageEdits.messageId, messageId),
          eq(messages.channelId, channelId),
          eq(channels.environmentId, this.environmentId),
        ),
      )
      .orderBy(asc(messageEdits.editedAt));
    return rows.map((r) => ({
      prior_text: r.priorText,
      edited_at: toIso(r.editedAt),
    }));
  }

  /** Does this message exist in this channel of this tenant (chapter 3.23)?
   *
   * THE EDIT-HISTORY ROUTE NEEDS IT and `listMessageEdits` cannot supply it: an empty
   * list is the correct answer for a message with no edits (FR-023's 200-with-nothing)
   * and also what a message id that does not exist returns. Two facts, one value — so
   * the route asks this separately rather than reading a 404 out of an empty array. */
  async messageExistsIn(channelId: string, messageId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.channelId, channelId),
          eq(channels.environmentId, this.environmentId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Refuse the send if a hard cap is already met (chapter 3.10, FR-RTL-08).
   *
   * Reads the caps and the usage in ONE query, in the transaction that is about to
   * write. Both dimensions, because FR-RTL-06 configures a cap for each.
   *
   * No lock: see the note at the call site. Postgres will not take `FOR UPDATE` on
   * the nullable side of the outer join this read needs, and the overshoot it
   * would have bounded is small enough to state instead.
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
    /** REQUIRED, following `sendMessage`'s parameter (chapter 3.17, T012). Its only
     * caller is the send, and the `userId === undefined` disjunct in the ceiling check
     * below became unreachable when that parameter did. */
    userId: string,
    /** Whether the sender is a person (chapter 3.17, FR-018a, T047b). Threaded from the
     * ban check's row rather than read again: this method is inside the write
     * transaction, and a second SELECT on `users` here is a query every send would pay
     * to learn something the caller already knows. */
    senderIsPerson: boolean,
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
      // THE CROSSING IS WRITTEN BEFORE THE REFUSAL IS RAISED (the ordering rule).
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

    // THE `userId === undefined` DISJUNCT IS GONE, and only that half. `hard === null`
    // still means no ceiling is configured, which is the common case and the reason the
    // count below is not taken on every send.
    //
    // THE BOT EXEMPTION IS NOT HERE YET. FR-018a exempts a bot from this ceiling and
    // FR-018b requires the count to exclude bots as well — Phase 5's T047b, because
    // doing only the first leaves a bot's row displacing a person and the bot's own
    // send passing makes it look fixed.
    // A BOT IS EXEMPT FROM THE CEILING, AND THAT IS HALF OF IT (chapter 3.17, FR-018a,
    // FR-RTL-05 as amended). The clause now caps "unique active PERSONS"; FR-ANL-05
    // still meters "unique active users" and the insert above still counts a bot, which
    // is what makes a bot billed and exempt at the same time.
    //
    // The ceiling bounds a customer's human population. A customer's own software should
    // not be able to lock their people out of sending — and it would: the block below
    // refuses the FIRST send of a period by anyone once the count is reached, so the
    // person refused is not whoever caused it.
    if (!senderIsPerson) {
      return { caps: { messages: messages_, active_users: users_ }, sent };
    }
    if (users_.hard === null) {
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

    // THE COUNT EXCLUDES BOTS, AND THIS IS THE HALF THAT DECIDES WHETHER THE EXEMPTION
    // WORKS (FR-018b). Returning early above stops a bot being refused; it does nothing
    // about a bot's row sitting in this count and displacing a person. A test that
    // watches the bot's send succeed passes with only the first half applied.
    //
    // **THE JOIN FILTERS `kind` AND NOT `deleted_at`.** Three `users` joins in this file
    // pair with `isNull(users.deletedAt)` and it is the house idiom, so the wrong version
    // is the one a careful reader writes. `deleteUser` is a SOFT delete and leaves
    // `usage_active_users` alone, so adding that filter would make a deleted person's row
    // stop counting — and deleting users would become a way to free ceiling slots, which
    // it is not today. `users.itest.ts` pins the BILLED figure across a deletion and
    // nothing pins the enforced one, so no ratchet would have caught it.
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(usageActiveUsers)
      .innerJoin(users, eq(users.id, usageActiveUsers.userId))
      .where(
        and(
          eq(usageActiveUsers.environmentId, this.environmentId),
          eq(usageActiveUsers.period, period),
          eq(users.kind, "person"),
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
   * FR-RTL-07, FR-RTL-07).
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
   * what makes it at-most-once (FR-RTL-07) — the schema, not this code. A concurrent
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
    return recordCrossings(
      tx,
      this.environmentId,
      period,
      dimension,
      before,
      after,
      caps,
      organisationId,
    );
  }

  /** The organisation an environment belongs to — who gets told. */
  private async organisationOf(tx: Db): Promise<string | null> {
    return organisationOf(tx, this.environmentId);
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
        /** A CAST AND NOT A CHECK. `messages.attachments` is a bare `jsonb()` with no
         * `.$type<>()`, so drizzle infers `unknown` and this names it. Postgres
         * enforces no shape on the column; `data-model.md` argues why the claim sits
         * at each read site rather than once in the schema. */
        attachments: sql<Attachment[] | null>`${messages.attachments}`,
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
    return {
      ...row,
      // FR-007's `?? []`, AT THE READ. The column holds NULL for a message with no
      // attachments and `[]` is what a client gets, so exactly one place converts.
      // `?? []` and not `|| []`: an empty array is falsy to neither, but the habit of
      // `||` here is how a `0` or a `""` becomes a default somewhere else.
      attachments: row.attachments ?? [],
      created_at: toIso(row.created_at),
    };
  }

  /** Does this channel resolve IN THIS TENANT? (chapter 2.8.)
   *
   * The write path has asked since 2.2 — it needs the channel row to lock —
   * so it answers a foreign id with a 404. The read path never asked: a
   * tenant-scoped query over a foreign channel simply returns no rows, and
   * the endpoint dressed that as an empty page. The milestone suite caught
   * the two doors disagreeing about the same resource. */
  /** One channel by its id, scoped, with the two fields the by-id route reports
   * beyond FR-CHN-01's four (chapter 3.15, FR-003a).
   *
   * SCOPED IN THE WHERE CLAUSE and not filtered afterwards, for the reason
   * `addMembers` states: a foreign id and an absent one must both miss this read,
   * so both answer alike and neither reveals the other tenant's row.
   *
   * THIS ROUTE DID NOT EXIST. `channels.controller.ts` carried a create and a
   * member-add and no read, so a customer could create a channel and never read
   * its four fields back — while SC-001 named "read by id" as one of four verbs,
   * FR-003 said "every read", and `contracts/membership.md` had a row for it.
   * Three artifacts resting on a handler nobody wrote (analysis pass three). */
  async getChannelById(
    channelId: string,
  ): Promise<(ChannelRow & { archived_at: Date | null }) | null> {
    const rows = await this.db
      .select({
        id: channels.id,
        external_id: channels.externalId,
        type: sql<ChannelRow["type"]>`${channels.type}`,
        name: channels.name,
        metadata: sql<Record<string, unknown>>`${channels.metadata}`,
        archived_at: channels.archivedAt,
      })
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.environmentId, this.environmentId),
        ),
      );
    return rows[0] ?? null;
  }

  /** Whether this user is a member of this channel (chapter 3.15).
   *
   * No environment predicate, and that is safe rather than sloppy: `members` has
   * no `environment_id` — it is reached through `channels` and `users`, which is
   * why the catalogue calls it a `hop` — and every caller has already read the
   * channel scoped. A membership row for a channel this environment cannot see is
   * unreachable because the channel id came from a scoped read. */
  async isMember(channelId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.channelId, channelId), eq(members.userId, userId)))
      .limit(1);
    return rows.length > 0;
  }

  /** Whether this channel exists AND this caller may see it (chapter 3.15, FR-003).
   *
   * `channelExists` answers the first half and every read route used it. That was
   * enough while `channels.type` decided nothing; it is not enough now, and the gap
   * showed up as a leak rather than as a failure:
   *
   *     a channel that does not exist   → channelExists false → 404
   *     a private channel, non-member   → channelExists TRUE  → 200, empty page
   *
   * Two different answers, so the empty page announced that the channel was there.
   * FR-003 says every read answers identically to a channel that does not exist, and
   * the only way to keep that is for one predicate to produce both refusals.
   *
   * `userId` absent means the tenant is reading, which sees everything it owns. */
  async channelVisibleTo(channelId: string, userId?: string): Promise<boolean> {
    const [channel] = await this.db
      .select({ type: sql<ChannelRow["type"]>`${channels.type}` })
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.environmentId, this.environmentId),
        ),
      );
    if (!channel) return false;
    if (channel.type !== "private" || userId === undefined) return true;
    return this.isMember(channelId, userId);
  }

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
      /** Who is reading (chapter 3.15, FR-002, FR-003).
       *
       * THIS PARAMETER DID NOT EXIST, and its absence is why the history path had
       * nothing to check. The task said "add the same check to the history path" and
       * there was nowhere to put a caller: this function took a channel and a page,
       * `messages.service.history` passed neither, and the controller resolved no
       * principal. Three places, and a gap in any one makes a check unreachable.
       *
       * Absent means the TENANT is reading, the same convention `sendMessage` uses
       * — an application credential sees private channels (FR-005). */
      userId,
    }: {
      beforeSeq?: number;
      afterSeq?: number;
      limit: number;
      userId?: string;
    },
  ): Promise<MessageWithSender[]> {
    // MEMBERSHIP FIRST, WHEN A USER IS READING (chapter 3.15, FR-002, FR-003).
    //
    // A scoped read below would already exclude another tenant's channel; this is
    // the case inside one tenant, where the channel exists and the reader is not a
    // member of it. An EMPTY PAGE is the answer, and it is the same answer a channel
    // that does not exist gives — `listMessages` has always returned `[]` for an
    // unknown id rather than raising, so indistinguishability here is a matter of
    // not diverging from that.
    //
    // ORDERED BEFORE THE PAGE QUERY so a non-member's read costs one small lookup
    // rather than a page of rows this function then discards.
    if (userId !== undefined) {
      const [channel] = await this.db
        .select({ type: sql<ChannelRow["type"]>`${channels.type}` })
        .from(channels)
        .where(
          and(
            eq(channels.id, channelId),
            eq(channels.environmentId, this.environmentId),
          ),
        );
      if (channel?.type === "private" && !(await this.isMember(channelId, userId))) {
        return [];
      }
    }

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
      // WHEN IT WAS LAST EDITED, OR NULL (chapter 3.23, FR-003). Null for every
      // message that has never been edited, which is the common case and the reason
      // the read shape's version is nullable while `EditedMessageRow`'s is not.
      //
      // ON THE READ PATH BECAUSE A CLIENT CANNOT OTHERWISE TELL. An edit keeps the
      // sequence number (FR-002), so nothing about a re-read row says it changed —
      // a client comparing what it holds against a page of history would have to
      // diff the text to notice, and FR-021 says the platform does not compare texts.
      //
      // WHAT THIS IS *NOT*: the superseded text. That is `message_edits`, readable
      // only by a tenant key (FR-023a), and this column says an edit happened without
      // saying what it replaced.
      edited_at: messages.editedAt,
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
    return rows.map((row) => ({
      ...row,
      // `[]` UNTIL PHASE 5 ADDS THE COLUMN TO THE SELECT ABOVE. The shape is required
      // from this phase and the value arrives with T028.
      attachments: [],
      created_at: toIso(row.created_at),
      // `null`, NOT `undefined`, and the difference is what a test can see. An absent
      // key and a null one are the same value through `??` — the control test for this
      // field was green before the field existed because its first draft used `??`.
      edited_at: row.edited_at === null ? null : toIso(row.edited_at),
    }));
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
