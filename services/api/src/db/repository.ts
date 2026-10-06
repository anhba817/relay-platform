import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type {
  Attachment,
  DeliveredAttachment,
  MediaState,
} from "@relay/protocol";

import {
  DEFAULT_LIMITS,
  type LimitedOperation,
} from "../limits/policy";
import { RECORDS_NOTHING, type ActorContext } from "../audit/actor";
import { ACTION } from "../audit/moderation-routes";
import type { Db } from "./client";
import {
  apiKeys,
  applications,
  auditLog,
  channels,
  consumedEvents,
  environments,
  humans,
  members,
  mediaObjects,
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
//   tenant-scoped. As of the tenancy chapter they build the whole container stack:
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

/** Set a per-environment rate-limit override (FR-RTL-04).
 *
 * The columns are nullable and null means "no override" rather than zero -- refuse-everything
 * has to stay expressible. Written here rather than at a call site because the query engine
 * lives in this layer only (constitution I, ADR-16), and a test reaching for `sql` directly
 * is the lint rule firing rather than a shortcut.
 */
export async function setEnvironmentLimits(
  db: Db,
  {
    environmentId,
    restPerMinute,
  }: { environmentId: string; restPerMinute: number | null },
): Promise<void> {
  await db
    .update(environments)
    .set({ restLimitPerMinute: restPerMinute })
    .where(eq(environments.id, environmentId));
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
  // The tenancy chapter added the organisation above the application, and this
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
// Credentials. Part of the ADMIN surface, and that placement is
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
 * (FR-RTL-04, research R26).
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

/** Write a row for each threshold a usage increase crossed (FR-RTL-07), and
 * the organisation to tell about it.
 *
 * STANDALONE SINCE THE CONNECTION-METERING CHAPTER, and the reason is the same
 * one `usageFor` and `creditConnectionMinutes` give: `Repository` closes over an `environmentId` by
 * construction, and the caller that now needs this is the usage report route,
 * which holds a PLATFORM principal and therefore no environment at all. The
 * private methods on `Repository` stay as one-line delegations, so the quota
 * chapter's two call sites inside `sendMessage` read exactly as they did.
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

/** Everything the connect path needs, in ONE round trip (FR-RTL-05, FR-RTL-06).
 *
 * ENFORCED AT THE DOOR, because that is the operation this dimension meters. The
 * messages cap refuses sends; the connection-minutes cap refuses connects. A cap
 * that only refused sends would leave an idle listener burning the metered
 * resource with nothing to stop it.
 *
 * ONE QUERY, AND THE PLAN SAID TWO. Research R7 chose "a second call on the same
 * request rather than a heavier version of the first", because the quota
 * chapter's H2 had refused to put a usage join inside `environmentLimits`. H2 is still right
 * and `environmentLimits` is untouched — its OTHER caller is
 * `rate-limit.middleware.ts`, which runs on every `/v1` request and must not pay
 * for a join it never reads.
 *
 * But two calls cost what a join would have, at concurrency, and it was measured:
 * connect latency at 32-way went from 15.0ms to 17.6ms across four runs clustered
 * inside 0.7ms, and folding them back recovered 0.8ms of it. The mechanism is the
 * one the quota chapter's T033 already recorded — an extra round trip holds a pooled
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

/** Credit a batch of usage reports (FR-RTL-05).
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
 * THE LOCK THE QUOTA CHAPTER WANTED AND COULD NOT HAVE. Crediting is
 * read-then-write, so it takes `SELECT … FOR UPDATE` on the accounting row. That
 * chapter needed the same
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

/** The media worker's batch: objects whose verdict nobody has reached yet (FR-001).
 *
 * UNSCOPED, LIKE THE DISPATCHER'S READS AND FOR THE SAME REASON. One worker serves every
 * environment, so it takes the tenant from the row it finds rather than from a principal
 * — and the route above it takes no tenant parameter at all, which is the isolation
 * property to assert rather than a scope to add. A route that could be asked for one
 * tenant's objects would be a route worth forging.
 *
 * OLDEST FIRST, SO A FAILING OBJECT DOES NOT STARVE THE QUEUE BEHIND IT — and so the
 * 24-hour reap boundary FR-MED-10 will own is approached from the right end.
 *
 * AND THE ORDER IS WHAT COSTS, NOT THE FILTER. Every row matches `state = 'pending'`
 * today, so the predicate selects the table; `media_objects_pending_age` (migration 0019)
 * is a PARTIAL index on `created_at`, and it took a 50-row batch from a top-N heapsort
 * over 3,158 rows at 93 buffers to an index scan at 4. */
export async function pendingMediaObjects(
  db: Db,
  limit: number,
  /** A keyset cursor on the ordering column, so the worker can page through the whole
   * window in one sweep rather than re-reading the first page forever.
   *
   * THE FIRST VERSION HAD NO CURSOR AND THAT WAS A STARVATION BUG. Measured against a
   * lane with real history: **858 objects in the window, a batch of fifty**, and the
   * head of the queue never moves because an object nobody uploaded to stays `pending`
   * until FR-MED-10 reaps it. A fresh upload was row 858 and was never reached — the
   * sealed suite timed out at thirty seconds with the worker running perfectly and
   * logging nothing, because it logs only when something happened.
   *
   * AND THE CHAPTER'S OWN HEADLINE FIGURE ASSUMED PAGING. *"The whole backlog is 4.2 s
   * serial"* is the argument for the sweep over a client notice; it is only true if a
   * sweep is a whole pass. A fixed first page made the published arithmetic describe
   * something the code did not do. */
  after?: Date,
): Promise<
  Array<{
    id: string;
    objectKey: string;
    environmentId: string;
    mimeType: string;
    declaredBytes: number;
    createdAt: Date;
  }>
> {
  return db
    .select({
      id: mediaObjects.id,
      objectKey: mediaObjects.objectKey,
      environmentId: mediaObjects.environmentId,
      mimeType: mediaObjects.mimeType,
      declaredBytes: mediaObjects.declaredBytes,
      createdAt: mediaObjects.createdAt,
    })
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.state, "pending"),
        // The cursor, on the same column the index is keyed by, so a page is a range
        // scan rather than an OFFSET the planner has to walk past.
        ...(after ? [gt(mediaObjects.createdAt, after)] : []),
        // AND NOT OLDER THAN FR-MED-10's WINDOW, WHICH IS THE PREDICATE THAT KEEPS THE
        // QUEUE FROM STARVING. Found by running the sealed suite against a lane with
        // real history: 3,849 rows in `pending` and **811 of them from the last 24
        // hours**, the oldest from a week earlier. Oldest-first over the whole table
        // with a batch of fifty means a fresh upload is row 3,800 — and the 3,038 ahead
        // of it **never leave**, because an object nobody uploaded to stays `pending`
        // forever. The queue is not a backlog that drains; it is a wall.
        //
        // AN OBJECT PENDING FOR MORE THAN A DAY IS NOT THIS WORKER'S. FR-MED-10
        // destroys unreferenced objects after 24 hours, so the window is the clause's
        // and not a number chosen here — and the effect is that this queue holds only
        // objects a client could still be uploading to. What is given up is an object
        // whose PUT finished on the twenty-fifth hour, which FR-MED-10 was going to
        // destroy anyway.
        //
        // THE PARTIAL INDEX COVERS IT UNCHANGED. `media_objects_pending_age` is on
        // `created_at WHERE state = 'pending'`, so this predicate is a range on the
        // index's own key rather than a filter after it.
        gt(mediaObjects.createdAt, sql`now() - interval '24 hours'`),
      ),
    )
    .orderBy(mediaObjects.createdAt)
    .limit(limit);
}

/** What a verdict does to the row (FR-MED-03, FR-MED-04).
 *
 * `applied` false means the object was not `pending` any more. A second `ready` for a
 * `ready` object is an ordinary retry and answers 200; a verdict for a `rejected` object
 * is refused by the caller, because the bytes are gone and letting it through would move
 * a state whose object no longer exists.
 *
 * ONE STATEMENT, AND THE `pending` PREDICATE IS THE LOCK. `UPDATE … WHERE state =
 * 'pending'` is how two workers racing one object resolve: the second one updates zero
 * rows and learns it lost. That is the whole of plan open question 6's answer and it
 * needs no lease, because the transition itself is the compare-and-set.
 *
 * AND THE WORKER NEVER TOUCHES POSTGRES (ADR-04) — this runs inside the api, called by a
 * route on the internal seam, exactly as `creditConnectionMinutes` is. */
/** THE CHANNELS A MEDIA OBJECT IS REFERENCED FROM, for a caller that has no repository.
 *
 * **A MODULE-LEVEL SIBLING OF `recordMediaVerdict`, AND THE SCOPE IS AN ARGUMENT RATHER
 * THAN A CONSTRUCTOR.** `Repository.channelsReferencingMedia` is the delivery gate's,
 * and it takes its tenant from `this.environmentId` — which the verdict seam does not
 * have, because its caller is a worker. The query body is the same one, deliberately:
 * 4.12 built and tested it, and a second lookup written for this path would drift from
 * the one that decides who may read the bytes.
 *
 * **THE PREDICATE IS NOT OPTIONAL EVEN THOUGH THE LOOKUP WOULD WORK WITHOUT IT.**
 * `media_id` is a primary key, so an unscoped query returns exactly these rows. It would
 * also be a read of a shared table with no tenant predicate, which constitution I
 * forbids in the data-access layer and which `check-lane-scope.py` exists to find. The
 * environment travels out of the verdict's own `RETURNING` list so this can be asked
 * properly.
 *
 * The containment operand is built here as a bound value rather than in SQL from a
 * joined column — 4.12 measured the difference at 1,042 buffers against 84. */
export async function channelsReferencingMediaIn(
  db: Db,
  environmentId: string,
  mediaId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: channels.id })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(
      and(
        sql`${messages.attachments} @> ${JSON.stringify([
          { type: "media", media_id: mediaId },
        ])}::jsonb`,
        eq(channels.environmentId, environmentId),
      ),
    );
  return rows.map((row) => row.id);
}

/** WHICH OF A TENANT'S MEDIA OBJECTS NOTHING REFERENCES ANY MORE — FR-MED-10's predicate.
 *
 * **CALLED BY NOTHING YET, AND THAT IS NOT AN OVERSIGHT.** FR-MED-10's reaper does not
 * exist; `docs/12` row 22, the erasure chapter, is where it gets a caller.
 *
 * **CHAPTER 4.20 CAME CLOSE AND DID NOT TAKE IT, WHICH IS WORTH RECORDING HERE BECAUSE
 * THE NEXT READER WILL HAVE THE SAME IDEA.** The retention sweep needs a reference
 * check and this function is one, so reusing it looked free. It asks a different
 * question: *which objects in this environment older than X does no message reference*
 * — a superset that includes objects **never attached to anything**, 48 of them in one
 * environment on the development lane. Those are this function's own population,
 * FR-MED-10's orphans, and a retention policy has nothing to do with them. The sweep
 * brings the `media_id` values of the messages it just destroyed instead, to
 * `unreferencedAmong` below, which is the half the two callers share. Chapter 4.15
 * writes the predicate here anyway because the alternative is what happened to
 * FR-MED-07's first sentence — three chapters cited the clause, every one of them
 * implemented the half it needed, and nobody noticed the other half was unmet. A
 * predicate with a test and no caller is weaker than one with both, and much stronger
 * than a sentence in a specification. Its test drives it directly.
 *
 * **A RENDITION IS NEVER RETURNED, WHICH IS THE WHOLE OF FR-002.** The obvious reading —
 * *"a rendition is unreferenced when its parent is"* — would have the reaper delete
 * parent and rendition separately and depend on the order. It does not need to: a
 * rendition cannot outlive its parent, because `media_objects_parent_fk` is
 * `ON DELETE CASCADE`. So this asks only about uploads, and the renditions follow. The
 * clause *"its reachability is its parent's"* is discharged by the foreign key rather
 * than by a second arm of a predicate somebody has to keep in step.
 *
 * **TWO QUERIES, NOT ONE, AND 4.12 MEASURED WHY.** The natural single statement puts
 * `NOT EXISTS (… attachments @> … m.id …)` against each candidate, which builds the
 * containment operand from a column on the other side of the join — a GIN index cannot
 * be looked up with a value the planner does not have yet, and that chapter measured the
 * difference at **1,042 buffers against 84**, with the index present and idle. Here the
 * candidates come back first and their ids go into the second query as bound values.
 *
 * The scope is an argument rather than a constructor, for `channelsReferencingMediaIn`'s
 * reason: the caller will be a job, not a request. */
export async function unreferencedMediaIn(
  db: Db,
  environmentId: string,
  olderThan: Date,
  limit = 100,
): Promise<string[]> {
  const candidates = await db
    .select({ id: mediaObjects.id })
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.environmentId, environmentId),
        isNull(mediaObjects.parentId),
        lt(mediaObjects.createdAt, olderThan),
      ),
    )
    .orderBy(mediaObjects.createdAt)
    .limit(limit);
  if (candidates.length === 0) return [];

  // ONE QUERY FOR THE WHOLE BATCH: the messages that reference AT LEAST ONE candidate,
  // each containment operand a bound value so the GIN index on `messages.attachments`
  // can be looked up rather than scanned. What comes back is the attachment arrays, and
  // the intersection is arithmetic in Node — cheaper than asking Postgres to unnest and
  // far easier to read than a lateral join nobody will revisit.
  return unreferencedAmong(
    db,
    environmentId,
    candidates.map((row) => row.id),
  );
}

/** OF THESE OBJECT IDS, WHICH DOES NO SURVIVING MESSAGE REFERENCE?
 *
 * Called by `unreferencedMediaIn` above, which brings every old object in an
 * environment, and by `sweepRetention` in `../retention/sweep.ts`, which brings the
 * `media_id` values of the messages it has just destroyed. **The two populations are
 * different and only the caller knows which one it means** — the sweep must not be
 * handed the first, because it contains objects that were never attached to anything,
 * and those are FR-MED-10's orphans rather than FR-MED-11's. On this lane that is 48
 * objects in one environment: a sweep destroying them would be enforcing the wrong
 * clause under a retention policy.
 *
 * ONE QUERY FOR THE WHOLE BATCH, AND IT REACHES THE INDEX. The operand of each
 * containment test is a bound value rather than a column from the other side of a
 * join, which is what chapter 4.12 measured the difference of: bound, the planner uses
 * `messages_attachments_gin`; set-wise it cannot, and the same index sits idle under a
 * parallel sequential scan. Measured here at 100 candidates — a `BitmapOr` over 100
 * `Bitmap Index Scan`s, 976 buffers and 15.2 ms, about 9.8 buffers an object against
 * 107 for a single one issued alone.
 *
 * **AN `OR` IS NOT ALWAYS A `Filter:`**, which is worth saying because chapter 4.18
 * found the opposite for a keyset cursor written as one. A cursor's range predicates
 * cannot be ORed into an index scan; containment predicates can, and this was checked
 * rather than assumed. */
export async function unreferencedAmong(
  db: Db,
  environmentId: string,
  candidateIds: readonly string[],
): Promise<string[]> {
  if (candidateIds.length === 0) return [];

  const rows = await db
    .select({ attachments: sql<Attachment[] | null>`${messages.attachments}` })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(
      and(
        eq(channels.environmentId, environmentId),
        or(
          ...candidateIds.map(
            (id) =>
              sql`${messages.attachments} @> ${JSON.stringify([
                { type: "media", media_id: id },
              ])}::jsonb`,
          ),
        ),
      ),
    );
  const referencedIds = new Set<string>();
  for (const row of rows)
    for (const attachment of row.attachments ?? [])
      if (attachment.type === "media") referencedIds.add(attachment.media_id);

  return candidateIds.filter((id) => !referencedIds.has(id));
}

export async function recordMediaVerdict(
  db: Db,
  input: {
    id: string;
    verdict: "ready" | "rejected";
    verifiedBytes?: number;
    verifiedType?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    reason?: "declaration_mismatch" | "scan_failed";
    /** FR-MED-05. Already written to the store by the worker; this records the row. */
    rendition?: {
      id: string;
      kind: string;
      objectKey: string;
      bytes: number;
      width: number;
      height: number;
    };
    renditionFailedReason?: string;
  },
): Promise<{
  applied: boolean;
  state: string | null;
  /** 4.16: the quota's quantity, so a `rejected` delta can negate it. `null` only when
   * no such object exists, like the fields beside it. */
  declaredBytes: number | null;
  mimeType: string | null;
  objectKey: string | null;
  /** THE TENANT, BECAUSE THIS FUNCTION IS THE ONLY PLACE THAT KNOWS IT (chapter 4.14).
   *
   * This is a module-level function on a raw `Db`, deliberately outside the
   * tenant-scoped repository, because its caller is a worker rather than a tenant — and
   * the worker's principal carries `environmentId: undefined` by design (4.4). FR-MED-07
   * needs the transition announced on every channel referencing the object, and that
   * lookup is scoped by environment. Without this value the caller's only options are a
   * second read that can disagree with the compare-and-set, or an unscoped query, which
   * is constitution I in the data-access layer.
   *
   * `null` only when no such object exists, which the caller answers with a 404. */
  environmentId: string | null;
}> {
  return db.transaction(async (tx) => {
  const [updated] = await tx
    .update(mediaObjects)
    .set({
      state: input.verdict,
      verifiedBytes: input.verifiedBytes ?? null,
      verifiedType: input.verifiedType ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      durationMs: input.durationMs ?? null,
      rejectedReason: input.reason ?? null,
      renditionFailedReason: input.renditionFailedReason ?? null,
    })
    .where(and(eq(mediaObjects.id, input.id), eq(mediaObjects.state, "pending")))
    .returning({
      state: mediaObjects.state,
      // THE KEY COMES BACK FROM THE UPDATE, not from a read before it. A rejection
      // deletes the bytes and the caller needs the key to do that; fetching it
      // separately would open a window in which the row moved between the two
      // statements and the delete addressed somebody else's object.
      objectKey: mediaObjects.objectKey,
      // AND THE TENANT, for the same reason: the fan-out FR-MED-07 needs is scoped by
      // environment, and this statement is the only one that knows which.
      environmentId: mediaObjects.environmentId,
      // AND THE BYTES AND THE MIME TYPE (4.16), which the verdict seam needs and did not
      // have. A `rejected` delta has to negate the quota's own quantity —
      // `declared_bytes`, which `reserveMediaSlot` sums — and FR-009's per-kind count
      // needs the type. The input carries a field called `kind` and it is the
      // RENDITION's (`"thumbnail"`), which is the near-miss a reader would use by
      // accident. **Third chapter running that this list was short**: 4.14 added
      // `environmentId`, 4.15 added `userId`, and each time the repair was the same —
      // the statement that already reads the row is the one that should say.
      declaredBytes: mediaObjects.declaredBytes,
      mimeType: mediaObjects.mimeType,
      // AND THE UPLOADER (4.15), so a rendition inserted below carries the same
      // `user_id` as its parent. FR-MED-10's second sentence makes compliance erasure
      // delete *"a user's media objects and derived objects"*, and it will find both on
      // one predicate only if the rendition was written with the parent's user. Reading
      // it from the same statement rather than a second SELECT is this list's whole
      // argument, applied once more.
      userId: mediaObjects.userId,
    });

  if (updated) {
    // FR-MED-05's ROW, IN THE SAME TRANSACTION AS THE TRANSITION THAT EARNED IT.
    //
    // **THERE WAS NO TRANSACTION HERE UNTIL CHAPTER 4.15, AND THE PLAN SAID THERE WAS.**
    // An analysis pass found it by opening this function rather than by reading the
    // plan, which had written "insert the rendition row in the same transaction as the
    // verdict" about a bare `UPDATE`. Without one, an UPDATE that lands and an INSERT
    // that fails leaves the parent `ready` with no rendition AND no recorded reason —
    // the absence FR-007 forbids and the silence FR-008 was written against.
    //
    // **TWO MECHANISMS, TWO DIFFERENT WINDOWS, AND NEITHER IS REDUNDANT.** `RETURNING`
    // above is still how the key and the tenant come back, because a separate SELECT
    // could read a row that moved between the two statements. The transaction is what
    // makes the verdict and the rendition one fact. A reader who sees both should not
    // conclude that one of them is belt-and-braces.
    if (input.rendition) {
      await tx.insert(mediaObjects).values({
        id: input.rendition.id,
        environmentId: updated.environmentId,
        // THE PARENT'S UPLOADER, so erasure by user finds the rendition on the same
        // predicate that finds the object it came from (FR-MED-10's second sentence).
        userId: updated.userId,
        filename: `${input.rendition.kind}.webp`,
        mimeType: "image/webp",
        // NOBODY DECLARED THIS. The column's comment says so; the quota sums it, and
        // FR-012 wants derived bytes counted on the same basis as uploaded ones.
        declaredBytes: input.rendition.bytes,
        state: "ready",
        objectKey: input.rendition.objectKey,
        width: input.rendition.width,
        height: input.rendition.height,
        verifiedBytes: input.rendition.bytes,
        verifiedType: "image/webp",
        parentId: input.id,
        rendition: input.rendition.kind,
      });
    }
    return {
      applied: true,
      state: updated.state,
      declaredBytes: updated.declaredBytes,
      mimeType: updated.mimeType,
      objectKey: updated.objectKey,
      environmentId: updated.environmentId,
    };
  }

  // NOT `pending`: either somebody got there first, or the object does not exist. The
  // caller needs to tell those apart, so the current state comes back rather than a
  // bare false.
  const [row] = await tx
    .select({
      state: mediaObjects.state,
      declaredBytes: mediaObjects.declaredBytes,
      mimeType: mediaObjects.mimeType,
      objectKey: mediaObjects.objectKey,
      environmentId: mediaObjects.environmentId,
    })
    .from(mediaObjects)
    .where(eq(mediaObjects.id, input.id));
  return {
    applied: false,
    state: row?.state ?? null,
    declaredBytes: row?.declaredBytes ?? null,
    mimeType: row?.mimeType ?? null,
    objectKey: row?.objectKey ?? null,
    environmentId: row?.environmentId ?? null,
  };
  });
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

    // THE CROSSINGS, IN THE SAME TRANSACTION AS THE CREDIT (FR-RTL-07). The report
    // knows the figure before and after, so it knows which thresholds it crossed —
    // which is why this chapter has no periodic
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
 * (FR-RTL-05).
 *
 * ZEROS FOR A PERIOD WITH NO ROWS, not null and not an error. An environment that
 * has sent nothing has used nothing, and making every caller tell "no usage" apart
 * from "no row" would push a schema detail into each of them.
 *
 * A NULL QUOTA IS CARRIED THROUGH AS NULL rather than resolved to `Infinity` or
 * `-1`. The absent state stays absent all the way to the reader — the same rule
 * the rate-limit chapter's nullable limit columns encode, and the reason `capsFor` returns
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
      // The connection-metering chapter's figure, read from the ROLL-UP and never summed over
      // `usage_connections` — that sum is proportional to the tenant's
      // connections for the month, which is the quota chapter's R1 argument in a new
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

/** The outbox drain, a FOURTH time — after the outbox chapter's events, the webhook
 * dispatcher chapter's deliveries and the mail-transport chapter's disablement
 * emails. Same claim predicate, same per-row error handling, same required batch
 * size.
 *
 * PER-ROW `try`/`catch` WITH A REQUIRED `onError`, and the default that used to
 * sit on the mail-transport chapter's version is not repeated here: it discarded a
 * row's failure with no log line, and feature 030's R48 removed it after finding it
 * as this file's last
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
// The outbox drain (ADR-06). Part of the ADMIN surface for the
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
// The disablement notifications (FR-018 to FR-020). THE OUTBOX A
// THIRD TIME — after the outbox chapter's events and the webhook dispatcher chapter's deliveries — and
// this one needed no migration at all: the retry-and-disable chapter gave the table a
// `delivered_at` column and left it null throughout, which is a claim predicate
// already written down.
//
// The backlog the disablement chapter accumulated therefore drains on the first run
// with NO SPECIAL
// HANDLING. By the predicate's own definition those rows are undelivered work,
// and code that treated them as a migration would be code asserting they are
// different when they are not (FR-020).
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
 * AN EXPLICIT LIMIT, no default. The deduplication chapter's baseline found four suites broken
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
  /** REQUIRED, AND IT CARRIED A DEFAULT UNTIL THE RATCHET ASKED. `= () => {}` was
   * never constructed: the one caller is `notification-relay.ts`'s `drainOnce`, which
   * has always passed a logging callback, so v8 counted the default as a function that
   * exists and never runs — `repository.ts` functions 99.12% against a pin of 100.
   *
   * DELETED RATHER THAN COVERED, which is what this file's ratchet is for and the sixth
   * time it has produced a deletion. A default that swallows a delivery failure silently
   * is the wrong default anyway: this parameter is how a caller learns that a row was
   * claimed and not sent, and making it required means the compiler asks the question
   * rather than a reviewer. */
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

/** The addresses to notify for an organisation, at SEND TIME (FR-022).
 *
 * Resolved from the row's `organisation_id`, which the retry-and-disable chapter denormalised onto
 * the notification precisely so this lookup could not follow the endpoint's
 * CURRENT owner. An application that moved between organisations after the
 * disablement must not silently retarget an obligation already owed to somebody
 * else — the disablement chapter wrote the reason down and this is the first code to
 * depend on it.
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
 * run it (the broker chapter's data model). */
export const DISPATCHER_CONSUMER = "dispatcher";

/** Whether a path segment could be a uuid at all (FR-CHN-11).
 *
 * A SHAPE TEST AND NOT A VALIDATION. Nothing here asks whether the uuid names a
 * row — only whether handing it to a `uuid` column can raise `22P02`, which is
 * the question `resolveChannelId` has to answer before it writes a predicate.
 * The 500 this chapter opens on is that cast, so the one branch that matters is
 * the negative one: a value failing this test is never compared to `channels.id`.
 *
 * Deliberately not `z.uuid()`. The repository layer takes no schema dependency
 * (the lint rule keeps the query engine here and the schemas out), and the
 * question is narrower than zod's: Postgres accepts any of the eight canonical
 * hex-and-dash forms and this is the one it will not raise on. */
const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Turn one event into one delivery per matching endpoint — **in one
 * transaction** (research R2).
 *
 * Admin surface, like `drainOutbox`: one dispatcher serves every environment, so
 * this cannot go through the scoped Repository. It is still safe, because the
 * environment comes from the EVENT rather than from a caller's parameter.
 *
 * The claim is the broker chapter's, unchanged, and it is doing more work here than it
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
 * transaction**.
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
 * gone on long enough (FR-006, FR-007).
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
     * every attempt since the webhook dispatcher chapter and discarded until this one
     * wanted it (research R6). Optional only so that callers written before it existed still compile;
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

/** Create the one delivery a test event needs (FR-013, research R8).
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

/** Disable every endpoint whose failure run has outrun the hour
 * (research R1, contract invariant 12).
 *
 * THE SECOND TRIGGER, and it is not belt-and-braces. The on-outcome check catches
 * every endpoint that is still receiving attempts, and research R1 measured that
 * this is not all of them. Against the webhook dispatcher chapter's tier table, one failing delivery
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
export async function sweepDisabledEndpoints(
  db: Db,
  limit = 100,
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
    // `FOR UPDATE OF e SKIP LOCKED` is the outbox chapter's pattern and here it does two
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
  // A TEST EVENT IS THE EXCEPTION, and it is the only one (FR-013).
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

/** Claim the deliveries that are due and hand each to `publish` — the outbox chapter's
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
      // In the `finally` for the outbox chapter's reason: whatever went wrong with row N+1,
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
// The consumer's deduplication ledger (SAD risk R5). Admin surface
// for the same reason the outbox drain is: it runs on behalf of the platform
// rather than of a tenant, and one consumer reads every environment's events.
// ---------------------------------------------------------------------------

/** What happened when a consumer tried to take an event. */
export type ClaimResult = "handled" | "duplicate";

/** Claim an event for a consumer and run its effect — **in one transaction**.
 *
 * This is the shape the outbox chapter used for the outbox row and the message it
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
 * idempotency keys, the tenancy chapter's on signup).
 *
 * **The limit of this, stated because the webhook dispatcher chapter will meet it**: the effect has
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
  /** Research R8: the environment's FIRST key, present only when
   * this call created the tenant. With no console session, nothing else can
   * bootstrap a credential — a brand-new organisation cannot authenticate a
   * request to ask for one. A returning owner gets no key, because the old
   * secret is unrecoverable and the answer to a lost secret is rotation. */
  apiKey?: { prefix: string; secret: string };
}

/** Signup (FR-TEN-01/02). The admin surface's second entrance:
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
    // belongs to. A key written outside this transaction could
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
  /** FR-023. Both columns have existed since chapter 2.1 and **no route
   * has ever written or read either one** — two of the four dead columns this feature
   * exists to give readers. They are on the row rather than fetched by a second query
   * because every caller that wants a profile wants all of it. */
  avatar_url: string | null;
  metadata: Record<string, unknown>;
  /** FR-031. Read on the send path and at connect. Like `deleted_at`, it
   * is selected rather than filtered so a caller can tell the states apart — a
   * repository that hid banned users would make the ban unobservable and the refusal
   * untestable. */
  banned_at: string | null;
  /** FR-017. A deleted user KEEPS THEIR ROW: `ON DELETE SET NULL` on
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
  /** FR-USR-07. What kind of thing this user is — `'person'` or `'bot'`.
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
   * chapter 2.1, and the channel-control chapter gave it its first DECISION. Before that it was
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
  /** (FR-001, FR-007). **REQUIRED, unlike `edited_at` below**, and the
   * contrast is the decision.
   *
   * `edited_at?` is optional so write paths need not spell `edited_at: null`, and that
   * convenience is exactly what made the attachments chapter's `internalSendResponseSchema` a break
   * waiting to happen: a field the type lets you omit is a field the gateway's strict
   * parse refuses at runtime, with no compiler anywhere in between. Required here means
   * every path that builds a row is named by `tsc` instead.
   *
   * `DeliveredAttachment[]` AND NOT `Attachment[] | null`, so the null lives only in
   * the column. FR-007: a message with none is returned with an empty list rather than
   * an absent or null field, and the `?? []` that makes that true belongs at the read,
   * once.
   *
   * **DELIVERED SINCE CHAPTER 4.14.** This interface is what a READ returns, and every
   * read runs `withMediaStates` over it, so a media attachment on a row that reaches a
   * caller always carries the state its object is in. A write path that builds one of
   * these has to say the state too — which is the compiler naming the sites rather than
   * a convention somebody has to remember. */
  attachments: DeliveredAttachment[];
  created_at: string;
  /** When it was last edited, or `null` (FR-003). Optional on this
   * interface rather than required, because the WRITE paths build a row that has never
   * been edited and would each have to spell `edited_at: null`. The read paths fill it
   * in; `EditedMessageRow` narrows it to a string. */
  edited_at?: string | null;
  /** Chapter 2.3 (FR-MSG-04): true when a retry was recognised by the
   * idempotency index and the ORIGINAL message was returned instead of
   * a new insert. The service layer uses this to decide response shape. */
  duplicate?: boolean;
}

/** An edited message, as the edit path returns it (FR-001, FR-003).
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
  /** When it was removed, or `null` (chapter 4.19, FR-007).
   *
   * **REQUIRED AND NULLABLE, UNLIKE `edited_at?` DIRECTLY ABOVE**, and the contrast is
   * the decision rather than an inconsistency. Three precedents were read before it was
   * taken. `edited_at?` is optional for write-path convenience — which its own comment
   * calls "exactly what made the attachments chapter's `internalSendResponseSchema` a
   * break waiting to happen". The USER row's `deleted_at: string | null` is required and
   * nullable, and its comment is this argument already written down: *"selected here
   * rather than filtered in the query so a caller can tell the two apart: a repository
   * that hid deleted rows would make the marker unobservable and the deletion
   * untestable."* And `text: string | null` on this very interface is the same shape for
   * the same class of value — null on most rows, load-bearing when it is not.
   *
   * The bill was counted before it was chosen: FIVE construction sites, read rather than
   * grepped, four of which must now spell `deleted_at: null`. A grep over the type's name
   * said fourteen and that figure was three times too large.
   *
   * WHY A CLIENT NEEDS IT. Three things describe one removal — the real-time
   * `message.deleted` frame, the webhook built from the outbox row, and this. The first
   * two carry the instant and history did not, so a client that was offline when the
   * message went learned that it is gone and not when. (The `DELETE` itself answers 204
   * with an empty body and carries nothing at all.) */
  deleted_at: string | null;
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

/** A write refused because the channel is archived (FR-020, FR-021).
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

/** A write or a connect refused because the user is banned (FR-031).
 *
 * FIRST IN FR-021a's ORDER, and the ban check runs BEFORE the channel is read at all —
 * so a banned user gets one answer for every channel id, whether it exists, belongs to
 * somebody else, or was invented. Any other position leaks: check the channel first and
 * a banned user learns which channel ids are real. */
/** An application credential named a person (FR-007, FR-007a).
 *
 * ITS OWN CLASS, NOT A `ChannelNotFoundError`, because the two say different things and
 * the service maps them to different codes. Carries the sender's INTERNAL id and never
 * the customer's identifier: the message on the wire names neither the person asked for
 * nor the bots that would have been accepted (SC-005). */
/** A media attachment this sender cannot attach (FR-001 through FR-005, FR-MED-06).
 *
 * ONE CLASS FOR THREE CONDITIONS, and that is the requirement rather than a shortcut.
 * The object may belong to another environment, to another user of this one, or to
 * nothing at all — and the service maps all three to one code and one message, because
 * distinguishing them would tell a caller whether somebody else's object exists. A
 * repository that threw three classes would be handing the service the material for an
 * existence oracle and trusting it not to use it.
 *
 * IT CARRIES THE INDEX AND NOT THE ID. The refusal's `field` is
 * `attachments.<n>.media_id`, so a caller with ten attachments is told which one — the
 * same courtesy the schema's own path gives. The ID is deliberately absent: echoing it
 * back reads as *"that one is wrong, try another"*, and a caller who can enumerate is
 * exactly who this refusal is for. */
export class MediaNotAttachableError extends Error {
  constructor(readonly index: number) {
    super("a media attachment names an object this sender cannot attach");
    this.name = "MediaNotAttachableError";
  }
}

export class SenderNotPermittedError extends Error {
  constructor(readonly userId: string) {
    super("an application credential may send only as a bot user");
    this.name = "SenderNotPermittedError";
  }
}

/** The message id does not name a message of this channel (FR-014).
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

/** The caller did not write this message (FR-013, FR-018, FR-022).
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

/** An edit was asked for on a tombstone (FR-010).
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
  /** FR-009. `enabled: false` with `disabled_at: null` means the
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
   * first. the outbox chapter's finding 3, in its third chapter. */
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
  //
  // THE THIRD ARGUMENT IS OPTIONAL, AND THAT IS A MEASUREMENT RATHER THAN A PREFERENCE.
  // Required, the compiler names every construction site — which is the property chapter
  // 4.14 wanted and got — and here that is **110 sites across 32 test files**, 17 of them
  // fenced across 131 pages, to give an actor to repositories that will never record
  // anything. Optional, the compiler names none, so the check moves to a test that reads
  // the source: an optional parameter is a check the compiler stopped doing, and
  // `repository.itest.ts` is what replaces it.
  constructor(
    private readonly db: Db,
    private readonly environmentId: string,
    private readonly actor?: ActorContext | typeof RECORDS_NOTHING,
  ) {}

  /** The environment this repository is scoped to, readable.
   *
   * EXPOSED SO A CALLER NEED NOT REACH FOR THE PRINCIPAL'S OPTIONAL CHAIN.
   * `req.principal?.environmentId ?? "unknown"` reads the same id and carries a branch
   * the guard makes unreachable — a request without a principal never reaches a
   * controller — and an unreachable branch in a file pinned at 100% is a coverage
   * failure with no fix but a comment. The ratchet found exactly that arm at 75%.
   *
   * The id, not a widened operation: the environment still comes from a verified
   *
   * AND A SECOND CALLER WITH A DIFFERENT NEED, which is why this reads as an accessor
   * rather than as one route's convenience. The test event wants an UNSCOPED operation:
   * `createTestDelivery` ignores subscriptions and `enabled`, so it cannot be a method
   * on this class at all — and it must still be told which environment is asking.
   * Exposing the id rather than widening the operation keeps constitution I's shape
   * either way, and the two reasons arrive from opposite directions: one wanted to stop
   * reading an optional chain, the other cannot use a scoped method.
   *
   * The ledger deferred this accessor to the webhook chapter on the strength of THAT
   * second reason — the comment it was attached to — and the membership chapter needed
   * it five chapters earlier for the first. A deferral justified by a comment is a
   * deferral justified by one caller's opinion of why the code exists. */
  get environment(): string {
    return this.environmentId;
  }

  /** Write one audit entry, inside the caller's transaction (FR-MOD-03, FR-005).
   *
   * Called by every recording method in this class — `banUser`, `unbanUser`,
   * `deleteUser`, `removeMembers`, `setMemberRole`, `archiveChannel`,
   * `unarchiveChannel` and `deleteMessage` — after each has established that its action
   * changed something.
   *
   * `tx` IS THE ACTION'S OWN TRANSACTION AND THAT IS THE WHOLE OF FR-005. An entry
   * committed separately from the action it describes is a log that can disagree with
   * the platform, in both directions: an action with no entry if the second write fails,
   * and an entry for an action that rolled back.
   *
   * IT WRITES NOTHING WHEN THERE IS NO ACTOR, AND THAT IS NOT A SILENT FAILURE — it is
   * two things a check covers. A production `Repository` is built with an actor or with
   * `RECORDS_NOTHING`, and `db/repository.itest.ts` reads the source of every
   * construction site to say so, because the parameter is optional and the compiler
   * stopped asking. A repository built with neither is a test's, and a test that means
   * to exercise the log supplies one — `audit.itest.ts` asserts the entries appear, and
   * asserts that a `RECORDS_NOTHING` repository writes none.
   *
   * The alternative was throwing, and it was costed rather than dismissed: 30 `new
   * Repository(` sites across the eight test files that call a recording method would
   * have to supply an actor to go on testing something else. That buys a second guard
   * over the same property `repository.itest.ts` already guards, at four times the
   * price, and every one of those sites is a file the fence chain publishes. */
  /** The actor's kind, or `undefined` when this repository records nothing.
   *
   * Read by `deleteMessage` alone, which is the one action whose classification depends
   * on the credential (FR-002a): a tenant key deleting somebody else's message is
   * FR-MOD-02, a user deleting their own is chapter 3.23's FR-013, and a compliance log
   * that recorded the second would fill with ordinary user activity. */
  private get actorKind(): ActorContext["kind"] | undefined {
    const actor = this.actor;
    return actor === undefined || actor === RECORDS_NOTHING
      ? undefined
      : actor.kind;
  }

  private async recordAction(
    tx: Pick<Db, "insert">,
    entry: {
      action: string;
      targetKind: "user" | "message" | "membership" | "channel";
      targetId: string;
    },
  ): Promise<void> {
    const actor = this.actor;
    if (actor === undefined || actor === RECORDS_NOTHING) return;
    await tx.insert(auditLog).values({
      id: randomUUID(),
      environmentId: this.environmentId,
      // `new Date()` AND NOT `sql`now()``, which every other write in this class uses
      // for a timestamp. `now()` is the transaction's start instant, so a long
      // transaction would date the entry before the action it records — and the column
      // is millisecond-precision expressly so the read route's cursor can trust it.
      occurredAt: new Date(),
      actorKind: actor.kind,
      actorId: actor.id,
      action: entry.action,
      targetKind: entry.targetKind,
      targetId: entry.targetId,
      requestId: actor.requestId,
    });
  }

  // ---------------------------------------------------------------------
  // Hosted media. The slot's whole database half, in one method, because the
  // check reads what the insert writes.
  // ---------------------------------------------------------------------

  /** Reserve a slot, or report why not.
   *
   * ONE TRANSACTION. The storage cap is a sum over `media_objects` and the insert
   * adds to that sum, so unserialised two slots race the same remaining allowance
   * and both are issued — the read-then-write quota check a reader would copy out of
   * a chapter. `serializable` rather than a lock because the read is an aggregate
   * over a whole tenant's rows and there is no single row to lock.
   *
   * IT RETURNS FACTS AND NEVER A REFUSAL. The caller turns `refused` into
   * `media_storage_exhausted`; a repository that threw an HTTP error would be the
   * query layer deciding a protocol question. The numbers come back with it because
   * the message names them.
   *
   * AND IT IS HERE RATHER THAN IN `media/` BECAUSE THE LINT RULE IS A CONSTITUTION
   * CLAUSE. The first version of this chapter's service imported `drizzle-orm` and
   * was refused: *"the query engine lives inside the repository layer only
   * (constitution I, ADR-16)"*. Chapter 4.7 hit the identical wall and its record
   * says why the plan walks into it — the api owns the repository, so putting a
   * query "in the api" feels like putting it here. */
  async reserveMediaSlot(input: {
    id: string;
    userId: string | null;
    filename: string;
    mimeType: string;
    declaredBytes: number;
    objectKey: string;
  }): Promise<
    { reserved: true } | { reserved: false; committed: number; cap: number }
  > {
    return this.db.transaction(async (tx) => {
      // THE LOCK FIRST, AND IT IS THE SAME STATEMENT AS THE CAP READ.
      //
      // A TRANSACTION IS NOT ENOUGH ON ITS OWN, which is the part a reader copying this
      // will get wrong. Postgres defaults to READ COMMITTED: two concurrent slot
      // requests both run `sum(declared_bytes)`, both see the same committed figure,
      // both find room, and both insert. Wrapping a read and a write in BEGIN/COMMIT
      // makes them atomic, not serialised — nothing about the transaction stops the
      // other one reading the same number.
      //
      // `FOR UPDATE` on the environment row is what serialises them, and the row was
      // going to be read anyway for the cap, so the lock costs no extra statement. It
      // is held for the rest of the transaction, which is one sum and one insert.
      //
      // PER TENANT, WHICH IS THE WHOLE POINT. Two tenants' slot requests never wait on
      // each other; two of one tenant's do, in the order the database picks. That is the
      // narrowest lock that makes the arithmetic true — an advisory lock on a hash of
      // the environment id would do the same job and collide between tenants for free.
      //
      // The alternative is SERIALIZABLE isolation, which turns the race into a
      // serialisation failure the caller has to retry. That moves the problem to every
      // call site instead of solving it here, and this repository has one call site.
      const [env] = await tx
        .select({ quotaConfig: environments.quotaConfig })
        .from(environments)
        .where(eq(environments.id, this.environmentId))
        .for("update");
      // `storage_bytes` resolves like the other three dimensions, and an absent cap
      // stays absent rather than becoming `Infinity` or `-1` somewhere up the stack.
      const cap = capsFor(env?.quotaConfig, "storage_bytes").caps.hard;

      // A SUM OVER THE ROWS, NOT A COUNTER ON `environments` (constitution IV). The rows
      // already say what is committed; a counter would be a second source of truth for
      // it, and the first thing that goes wrong with one is a delete path that forgets
      // to decrement. The cost is a sum per slot request over one tenant's media rows,
      // on the index `media_objects_environment_idx` — and this chapter has no corpus at
      // a scale where that number would mean anything, so it is stated as a cost rather
      // than measured into a claim.
      //
      // AND THE VERIFICATION CHAPTER IS WHERE THE DELETE PATH ARRIVED, WHICH IS THE
      // SENTENCE ABOVE BEING TESTED. A rejected object's bytes are destroyed, so they
      // must stop counting — and the way they stop counting is that the ROW leaves the
      // sum, not that its `declared_bytes` is zeroed. Zeroing would destroy the fact
      // FR-MED-03 is about: what the client claimed, which is the audit record
      // FR-MED-04 says to keep. SRS 1.17 made committed bytes a sum over rows precisely
      // so a delete needs no subtraction, and this is that decision paying out.
      //
      // `pending` STILL COUNTS. An object under verification is bytes the store is
      // holding, so a tenant cannot open a thousand unverified slots to get around the
      // cap — and if it turns out bad, the next sum has already stopped charging.
      const [sum] = await tx
        .select({
          committed: sql<string>`coalesce(sum(${mediaObjects.declaredBytes}), 0)`,
        })
        .from(mediaObjects)
        .where(
          and(
            eq(mediaObjects.environmentId, this.environmentId),
            ne(mediaObjects.state, "rejected"),
          ),
        );
      const committed = Number(sum?.committed ?? 0);

      if (cap !== null && committed + input.declaredBytes > cap) {
        return { reserved: false as const, committed, cap };
      }

      await tx.insert(mediaObjects).values({
        id: input.id,
        environmentId: this.environmentId,
        userId: input.userId,
        filename: input.filename,
        mimeType: input.mimeType,
        declaredBytes: input.declaredBytes,
        objectKey: input.objectKey,
      });
      return { reserved: true as const };
    });
  }

  // ---------------------------------------------------------------------
  // Webhook endpoints. Scoped like everything else on this class:
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
        // (FR-017). The hour is measured from the NEXT failure, not
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
   * `environment_id` where the outbox chapter's and the broker chapter's ledger did not. */
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
        // `createUser` CANNOT MAKE A BOT, and that is deliberate. Its
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
          // never hands back null — and the isolation harness removed `addMember`'s
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
   * This was a plain insert until the endpoint over it, which is fine for a fixture and
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

  /** Turn whatever arrived in a path segment into this channel's key (FR-CHN-11).
   *
   * THE SHAPE TEST IS WHAT REMOVES THE 500, and it is not an optimisation. A path
   * segment that cannot parse as a uuid is handed to the identity query alone, so
   * `'order-88412'::uuid` never happens — and that cast is the whole of the defect
   * this chapter opens on. Postgres raises it before the `OR` beside it can
   * short-circuit, so a single `external_id = $2 OR id = $2::uuid` is not a
   * resolution that sometimes fails: it is one that always fails for every value
   * a customer is likely to send.
   *
   * THE IDENTITY WINS A TRUE TIE. An `external_id` is `z.string().min(1).max(255)`
   * and may itself be a uuid — legal, and 0 of 41,772 channels have one. When a
   * value could name both spaces, `order by (external_id = $2) desc` prefers the
   * channel the customer NAMED; the other stays reachable by its uuid from any
   * caller holding it. Key-first would strand a customer permanently with no error
   * they could act on, which is the only argument that decides this: the two
   * lookups cost the same, measured twice a day apart with the ordering reversing
   * between runs.
   *
   * ONE QUERY, AND BOTH ARMS ARE INDEX SCANS. 4.18 found a keyset cursor written
   * as an `OR` landing in a `Filter:` and re-walking every page, so this plan was
   * read before the form was chosen, not after:
   *
   *     Limit -> Sort -> Bitmap Heap Scan              shared hit=11   0.068 ms
   *       BitmapOr
   *         Bitmap Index Scan …_environment_id_external_id_unique   Index Cond
   *         Bitmap Index Scan channels_pkey                         Index Cond
   *
   * The key arm's tenancy lands on the heap recheck rather than in its index
   * condition — a foreign tenant's row enters the bitmap and is filtered out. That
   * reads as a leak and is not: the plain `channels_pkey` lookup every route runs
   * today does exactly the same thing.
   *
   * SCOPED BY CONSTRUCTION. `this.environmentId` comes from the constructor, which
   * is 4.21's mechanism: there is no predicate here for a later chapter to forget.
   * Delete it and `gauntlet.itest.ts` turns red.
   *
   * Called by `ChannelIdPipe.transform`, which is the only caller. */
  async resolveChannelId(segment: string): Promise<string | null> {
    const looksLikeUuid = UUID_SHAPE.test(segment);
    const rows = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(
          eq(channels.environmentId, this.environmentId),
          looksLikeUuid
            ? or(eq(channels.externalId, segment), eq(channels.id, segment))
            : eq(channels.externalId, segment),
        ),
      )
      .orderBy(sql`(${channels.externalId} = ${segment}) desc`)
      .limit(1);
    return rows[0]?.id ?? null;
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
   * THREE OUTCOMES, NOT A BOOLEAN (R14a). Until the endpoint over it, this returned
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
  /** THIS METHOD HAD NO TRANSACTION AND NOW HAS ONE, which is a
   * different change from adding a statement to an existing one.
   *
   * Constitution II: "State changes and their events MUST commit atomically via the
   * transactional outbox. Publish-after-commit without the outbox is forbidden."
   * the fan-out chapter's Redis publish is legal because `sendMessage` already wrote the
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
    /** FR-011b. Absent means the column's own default — `member` —
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
      // was a branch nothing could take — one uncovered arm in the file constitution
      // VI asks for 100% of, bought for nothing. A row that came back is a row that
      // was inserted.
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

  /** Archive and unarchive, both idempotent (FR-020, FR-020a).
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
    // FR-005a's EXCEPTION, THE THIRD AND FOURTH TIME. Neither of this pair had a
    // transaction and neither needed one for itself; both need one so the entry commits
    // with the change. The answers are unchanged.
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(channels)
        .set({ archivedAt: sql`now()` })
        .where(
          and(
            eq(channels.id, channelId),
            eq(channels.environmentId, this.environmentId),
          ),
        )
        .returning({ id: channels.id });
      if (updated.length === 0) return false;

      // FR-MOD-03. The target is the channel's uuid, which is what the route takes and
      // therefore what a customer already has — no threading, unlike the user cases.
      //
      // ARCHIVING AN ARCHIVED CHANNEL WRITES AN ENTRY, for the reason the comment above
      // gives for the boolean: this write is idempotent BY THE WRITE, so the statement
      // really did affect a row. The mechanical rule is uniform across the eight actions
      // and this is the case where it is most visibly a choice.
      await this.recordAction(tx, {
        action: ACTION.archiveChannel,
        targetKind: "channel",
        targetId: channelId,
      });
      return true;
    });
  }

  async unarchiveChannel(channelId: string): Promise<boolean> {
    // FR-005a's EXCEPTION, THE THIRD AND FOURTH TIME. Neither of this pair had a
    // transaction and neither needed one for itself; both need one so the entry commits
    // with the change. The answers are unchanged.
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(channels)
        .set({ archivedAt: null })
        .where(
          and(
            eq(channels.id, channelId),
            eq(channels.environmentId, this.environmentId),
          ),
        )
        .returning({ id: channels.id });
      if (updated.length === 0) return false;

      // FR-MOD-03. The target is the channel's uuid, which is what the route takes and
      // therefore what a customer already has — no threading, unlike the user cases.
      //
      // ARCHIVING AN ARCHIVED CHANNEL WRITES AN ENTRY, for the reason the comment above
      // gives for the boolean: this write is idempotent BY THE WRITE, so the statement
      // really did affect a row. The mechanical rule is uniform across the eight actions
      // and this is the case where it is most visibly a choice.
      await this.recordAction(tx, {
        action: ACTION.unarchiveChannel,
        targetKind: "channel",
        targetId: channelId,
      });
      return true;
    });
  }

  /** Set a member's role (FR-011).
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
  /** **NO OUTBOX ROW, AND NO FABRIC PUBLISH.** `membership.changed`'s
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
    userExternalId: string,
  ): Promise<"set" | "not_a_member"> {
    // THE TRANSACTION IS FR-005a's EXCEPTION, TAKEN A SECOND TIME. This method had none
    // and did not need one for its own sake; it needs one so the entry and the role
    // change commit together. The answer it returns is unchanged.
    return this.db.transaction(async (tx) => {
      const updated = await tx
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
      if (updated.length === 0) return "not_a_member";

      // FR-MOD-03. THE EXTERNAL ID IS THREADED HERE AND IT IS THE ONLY PLACE IT HAD TO
      // BE: this `RETURNING` carries a uuid, because unlike the ban and the removal this
      // method emits no customer-facing event and never needed the other identifier.
      //
      // AND SETTING THE ROLE A MEMBER ALREADY HOLDS WRITES AN ENTRY. The no-op rule in
      // this chapter is mechanical — did the write statement affect a row — and here it
      // did. Knowing whether the VALUE changed would need a SELECT inside the write
      // transaction, which is the query `deleteMessage` argues against paying on every
      // call, and the softer reading is defensible anyway: the moderator performed the
      // action and the platform carried it out.
      await this.recordAction(tx, {
        action: ACTION.setMemberRole,
        targetKind: "membership",
        targetId: `${channelId}/${userExternalId}`,
      });
      return "set";
    });
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
   * (FR-006, FR-007, FR-008).
   *
   * BULK, BECAUSE THE REQUIREMENT ALWAYS WAS. FR-006 says "up to 100 in one
   * request" and FR-007 says the result is reported per user — which is the
   * endpoints chapter's `addMembers` shape in both halves. `contracts/membership.md` specified a
   * single-user `DELETE …/members/:userExternalId` for ten analysis passes, having
   * read "the shape the channel-endpoints chapter chose" as *named outcomes* and dropped *bulk*.
   * Every pass compared requirements to tasks, both said "removal", and identifier
   * coverage read 100% the whole time.
   *
   * NO MESSAGES ARE TOUCHED (FR-008). The removed user's messages stay in history
   * attributed to them: `messages.user_id` still points at a row that still exists,
   * and their socket stops receiving the channel on its next resume because the
   * session is built from `members`.
   *
   * THE READ POSITION GOES WITH THE MEMBERSHIP, and the previous chapter wrote this
   * requirement down here rather than leaving it to be deduced. `read_positions` is
   * per-member state keyed by `(channel_id, user_id)`, so leaving a removed member's
   * row would leave a non-member's position in a per-member table.
   *
   * Adding the user back therefore starts their unread count at the channel's whole
   * history, which is the same thing "no row means position zero" says for a new
   * member — so the delete costs nothing a rejoin has to undo.
   *
   * SCOPED THROUGH THE CHANNEL, and the caller has already read it scoped. `members`
   * carries no `environment_id` — the catalogue calls it a `hop` — so the join is
   * what keeps a foreign channel's rows out of reach.
   */
  /** THIS ONE HAD NO TRANSACTION EITHER, and it was already two
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

      // FR-MOD-03, IN THE SAME LOOP AND FOR THE SAME REASON. One entry per member the
      // `RETURNING` gave back, so a bulk call naming five of which two were not members
      // writes three — the no-op rule applied per member rather than per request.
      //
      // AND THE EXTERNAL ID WAS ALREADY HERE, which is the second time in this chapter.
      // The plan had it threaded in from `channels.service.ts`, which does hold it; this
      // method's `RETURNING` has carried a `external_id` subquery since the membership
      // chapter, because the event one line up publishes the member as a customer sees
      // them. **A method that already emits a customer-visible event already holds
      // customer-visible identifiers**, and that is what the threading survey should
      // have asked.
      //
      // THE TARGET IS THE MEMBERSHIP, WHICH IS A PAIR, so the id is the two identifiers
      // the route carries with a slash between them. Unambiguous whatever the external
      // id contains — a uuid is 36 characters and cannot hold a slash, so the first one
      // is always the separator.
      await this.recordAction(tx, {
        action: ACTION.removeMember,
        targetKind: "membership",
        targetId: `${channelId}/${row.userExternalId}`,
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

  /** The channels a user belongs to, each with its revision count (feature 044, FR-014).
   *
   * ONE QUERY, NOT TWO. The count could have come from a second call, and giving each
   * caller its own is the two-lists-that-must-agree defect `gaps.md` 3.23-4 records about
   * `targets.ts` — two things that must match, maintained separately, with nothing
   * comparing them. The join costs nothing: `members` is already reached and `channels` is
   * one hop from it on a primary key.
   *
   * FR-014 IS WHY THE COUNT RIDES THIS QUERY AT ALL. At 10,000 connections a per-channel
   * read per handshake is 10,000 extra reads, and the reconnect rate measured before this
   * feature was 1,402 per second. The count has to arrive on work the api already does.
   *
   * TWO CALLERS, AND BOTH ARE REPAIRED IN THE SAME CHANGE. `session.controller.ts` wants
   * the counts; `memberships.controller.ts` wants ids alone and maps them. Widening the
   * return without fixing both leaves the second assigning objects to a `string[]`, which
   * is a typecheck failure at exactly the boundary this project commits at. */
  async channelsForUser(
    userId: string,
  ): Promise<{ channel_id: string; revision_sequence: number }[]> {
    return await this.db
      .select({
        channel_id: members.channelId,
        revision_sequence: channels.revisionSequence,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .innerJoin(channels, eq(channels.id, members.channelId))
      .where(
        and(
          eq(members.userId, userId),
          eq(users.environmentId, this.environmentId),
        ),
      );
  }

  /** Upsert a user by external id, updating the profile fields present
   * (FR-025, FR-026).
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
   * `status` REPORTS WHICH HAPPENED, per entry, in the shape the channel-endpoints chapter chose for
   * `addMember`: a partial outcome is reported per entry rather than collapsed into one
   * status code. */
  async upsertUser(
    externalId: string,
    profile: {
      display_name?: string | null | undefined;
      avatar_url?: string | null | undefined;
      metadata?: Record<string, unknown> | undefined;
      /** (FR-002b). ABSENT MEANS "NO CHANGE", NOT "PERSON" — the column
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
        // THE DEFAULT APPLIES HERE AND NOWHERE ELSE (FR-002b, T019a).
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
    // that class from the isolation harness and its lines ratchet sat at 99; a third took the file
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

    // A KIND CHANGE IS REPORTED, NOT PERFORMED (FR-002a, FR-002d).
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
    // FIX. The first version of this branch read the row back and threw if
    // it was absent, then returned `kind_conflict` — which is the second statement for one
    // impossible state that the comment forty lines below already argues against. Lines
    // fell to **98.95%** against a pin of 99 and the gate went red, exactly as that
    // comment predicts. Third time this project has answered the ratchet by removing code
    // rather than covering it (the user-surface chapter's `addMember` and its `upsertUser`).
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

  /** Ban and unban a user, tenant-wide (FR-031, FR-032).
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
  /** A BAN WRITES ONE `channel.member_removed` PER CHANNEL, and the
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

      // FR-MOD-03, AFTER THE GUARD AND INSIDE THE SAME TRANSACTION. After, because an
      // action that changed nothing earns no entry and `isNull(users.bannedAt)` above is
      // what makes a re-ban change nothing — the same guard that already stops the
      // events. Inside, because FR-005 wants the entry and the ban to commit or roll
      // back together.
      //
      // AND THE EXTERNAL ID WAS ALREADY HERE. The chapter's plan said this method would
      // have to be given it, on the reasoning that `setBanned` resolves the user and
      // hands over a uuid. It does — and the `RETURNING` three lines up reads the
      // external id back out, for the membership events. Nothing was threaded.
      await this.recordAction(tx, {
        action: ACTION.ban,
        targetKind: "user",
        targetId: externalId,
      });

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

  /** Lift a ban (FR-032), and record it (FR-MOD-03).
   *
   * THREE THINGS CHANGED HERE AND THEY ARE ONE CHANGE. Before this chapter the method
   * was a bare `update` with no transaction, no `RETURNING` and no `isNull` guard — so
   * lifting a real ban and unbanning somebody who was never banned were the same call
   * with the same answer, `void`. It could not tell whether it had done anything, which
   * is the one question FR-008 asks of every recording action.
   *
   * `isNotNull(bannedAt)` IS THE GUARD, and it is `banUser`'s in the mirror: that method
   * has had `isNull(bannedAt)` since the ban chapter, for exactly this reason, and the
   * pair was asymmetric for no recorded reason. The entry now follows the same rule as
   * the ban's — an unban that lifted nothing writes nothing.
   *
   * THE TRANSACTION IS FR-005a's EXCEPTION, TAKEN DELIBERATELY. FR-012 says this chapter
   * adds no transaction to an action that lacked one; four actions could not satisfy
   * both clauses and this is the first. What it buys is the entry committing with the
   * action. What it costs is a new way to fail, and the answer this method returns is
   * unchanged — `void` then, `void` now — so no caller sees a difference.
   *
   * THE EXTERNAL ID COMES FROM THE `RETURNING`, not from a threaded parameter. The
   * chapter's plan had it threaded from `users.service.ts`; once the method needed a
   * `RETURNING` anyway, the column was already coming back. */
  async unbanUser(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const lifted = await tx
        .update(users)
        .set({ bannedAt: null })
        .where(
          and(
            eq(users.id, userId),
            eq(users.environmentId, this.environmentId),
            isNotNull(users.bannedAt),
          ),
        )
        .returning({ externalId: users.externalId });

      if (lifted.length === 0) return;
      await this.recordAction(tx, {
        action: ACTION.unban,
        targetKind: "user",
        targetId: lifted[0]!.externalId,
      });
    });
  }

  /** Delete a user, keeping the row (FR-027, FR-028, FR-029).
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
  async deleteUser(userId: string, userExternalId: string): Promise<boolean> {
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
      // (FR-004a, T043b).
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
      // stamps the marker. It has **no production caller**: the user-surface chapter added it so the
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

      // FR-MOD-03, AND THE NO-OP TEST IS NOT THIS METHOD'S RETURN VALUE.
      //
      // `deleteUser` answers `true` for a user it just deleted AND for one already
      // deleted — the `?? new Date()` above keeps the original instant, so the second
      // call changes nothing and still reports `true`. The boolean means "a row
      // existed", which is what the route needs to tell 200 from 404; it does not mean
      // "something changed". Chapter 4.18's own phase-2 survey read it as the no-op
      // discriminator and was wrong.
      //
      // `alive.deletedAt` is the discriminator. A second deletion writes no entry, for
      // the same reason a re-ban writes none.
      if (alive.deletedAt === null) {
        await this.recordAction(tx, {
          action: ACTION.deleteUser,
          targetKind: "user",
          targetId: userExternalId,
        });
      }
      return true;
    });
  }

  /** Erase an end user — FR-MOD-04's traversal through every Postgres store that
   * names them. The analytical half is `users/erasure.ts`; constitution III keeps the
   * two apart and the receipt reports them separately.
   *
   * **THIS IS NOT `deleteUser`, AND THE DIFFERENCE IS THE POINT.** That method is
   * FR-USR-05's and keeps the row, the messages and the `usage_active_users` rows ON
   * PURPOSE. This one keeps the messages and the billing rows for the same two clauses
   * and destroys everything that identifies the person, `external_id` included.
   * `erasure.itest.ts` asserts the two side by side so they cannot drift together.
   *
   * ## WHY THE ROW SURVIVES, WHICH IS THE WHOLE STRUCTURE IN ONE PARAGRAPH
   *
   * FR-USR-05 keeps the messages — *"preserving their messages as authored by a
   * deleted user"* — so `messages.user_id` stays. All five foreign keys to
   * `users` are `NO ACTION`, so the row is then unreachable: there is no "delete the
   * row last", because there is no deleting it at all. `erasure.itest.ts`'s first test
   * is that refusal, with a control.
   *
   * And that is what makes the rest legal. The row becomes a tombstone holding nothing,
   * so every other store that references the user BY KEY — `usage_active_users`, the
   * `uniq` sketches — stops naming anybody without being touched. One decision, three
   * consequences, and `baseline.txt`'s T010 and T011 carry the argument.
   *
   * ## `external_id` IS REPLACED, NOT CLEARED, AND THE COLUMN IS WHY
   *
   * It is `NOT NULL` under `users_environment_id_external_id_unique`, so there is no
   * null to write. The replacement is `erased:<users.id>` — unique by construction
   * because the uuid is the primary key, and non-identifying for exactly the reason
   * T011 established. **The two decisions hold each other up**: without the key
   * argument there would be no safe value to put here.
   *
   * A SECOND ERASURE THEREFORE ANSWERS 404, not a 200 with an empty receipt, because
   * no user has that external id any more. `contracts/erasure.md` carries the cost and
   * why a hash is refused.
   *
   * `description` IS NOT CLEARED, for FR-004a's reason one method down: it says what a
   * bot IS, and clearing it violates `users_bot_description_check`, which would make a
   * bot the one kind of user that cannot be erased.
   *
   * RETURNS THE MEDIA ROWS rather than a count, because the caller owes a
   * `deleteObjectWithRenditions` and a negative `deleted` storage event per object —
   * `destroyMediaObjects`' convention, and neither is reconstructable from a number. */
  async eraseUser(
    userId: string,
    userExternalId: string,
  ): Promise<{
    profile: number;
    readPositions: number;
    memberships: number;
    messagesRetained: number;
    activeUserRowsRetained: number;
    media: Awaited<ReturnType<Repository["destroyMediaObjects"]>>;
  }> {
    // THE MEDIA IDS COME OUT BEFORE THE TRANSACTION, because `destroyMediaObjects`
    // opens one of its own. Collecting them first is also the ordering rule
    // `data-model.md` states: a value that lives on a row the traversal destroys has
    // to be read before the row goes. Chapter 4.20 paid this with `media_id`.
    const owned = await this.db
      .select({ id: mediaObjects.id })
      .from(mediaObjects)
      .where(
        and(
          eq(mediaObjects.userId, userId),
          eq(mediaObjects.environmentId, this.environmentId),
          isNull(mediaObjects.parentId),
        ),
      );

    const media = await this.destroyMediaObjects(owned.map((o) => o.id));

    return this.db.transaction(async (tx) => {
      const [alive] = await tx
        .select({ id: users.id, deletedAt: users.deletedAt })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.environmentId, this.environmentId)))
        .limit(1);
      if (alive === undefined) {
        throw new Error(`eraseUser: no user ${userId} in this environment`);
      }

      const positions = await tx
        .delete(readPositions)
        .where(eq(readPositions.userId, userId))
        .returning({ userId: readPositions.userId });
      const memberships = await tx
        .delete(members)
        .where(eq(members.userId, userId))
        .returning({ userId: members.userId });

      // COUNTED, NOT DELETED. Both are `retained_anonymous` on the receipt: the rows
      // stay under a named clause and the key they carry now resolves to a tombstone.
      // The counts are what let the receipt say so with a number instead of a promise.
      const retainedMessages = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.userId, userId));
      const retainedActive = await tx
        .select({ userId: usageActiveUsers.userId })
        .from(usageActiveUsers)
        .where(
          and(
            eq(usageActiveUsers.userId, userId),
            eq(usageActiveUsers.environmentId, this.environmentId),
          ),
        );

      await tx
        .update(users)
        .set({
          displayName: null,
          avatarUrl: null,
          metadata: {},
          externalId: `erased:${userId}`,
          deletedAt: alive.deletedAt ?? new Date(),
        })
        .where(eq(users.id, userId));

      // FR-013, AND THE ENTRY CARRIES THE NAME IT JUST ERASED.
      //
      // `targetId` is the EXTERNAL id, as every other user-target entry in this log
      // is — 1,357 of 1,357, not one of them a uuid. Writing the uuid instead was
      // considered and refused: this entry is the operator's only proof the erasure
      // happened, and FR-MOD-03's log exists to demonstrate exactly that. The log is
      // append-only (ADR-35), so the receipt reports it as `cannot_erase` and the
      // chapter says plainly that the one place the name survives is the record that
      // the name was erased.
      //
      // UNCONDITIONAL, unlike `deleteUser`'s. That method skips the entry on a second
      // call because the user was already deleted; a second erasure cannot reach this
      // line at all, because the external id it would be called with no longer exists.
      await this.recordAction(tx, {
        action: ACTION.eraseUser,
        targetKind: "user",
        targetId: userExternalId,
      });

      return {
        profile: 1,
        readPositions: positions.length,
        memberships: memberships.length,
        messagesRetained: retainedMessages.length,
        activeUserRowsRetained: retainedActive.length,
        media,
      };
    });
  }

  /** Write a user's profile (FR-023, FR-024).
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
      /** FR-004. `string | undefined` and NOT `| null`, unlike its three
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

  /** Record a read position (FR-017, FR-018).
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

  /** Mark a user deleted, keeping the row (FR-017).
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

  /** A user's channels, most recently active first, keyset-paginated (the
   * channel-control chapter, FR-013, FR-CHN-08).
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
      /** THE SENDER MUST BE A BOT (FR-007, T030, T032).
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
      /** REQUIRED SINCE THIS CHAPTER (FR-MSG-15, FR-006), and required is the whole
       * mechanism. SC-003 asks that no write path be able to produce a senderless
       * message; a runtime check would be a test somebody has to remember, and this
       * is a compile error. `exactOptionalPropertyTypes` means a caller cannot pass
       * `undefined` here either — passing a `string | undefined` is named by the
       * compiler, not silently accepted.
       *
       * There is no red test for this. Reverting the `?` is what makes the guarantee
       * visible, and the transcript of that revert is SC-003a's evidence (T013a). */
      userId: string;
      /** The sender as a CONSUMER will see them. Threaded from the
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
    // FR-MED-07: decorated AFTER the transaction commits. The media state is not
    // part of this write and reading it on the transaction's own connection would
    // tie one fact's freshness to another's commit. One extra statement.
    return this.withMediaState(
      await this.db.transaction(async (tx) => {
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
      // EVERY SEND IS ATTRIBUTED NOW (FR-MSG-15). The gate that used to
      // stand here — `if (userId !== undefined)` — guarded against a key-authenticated
      // send that carried no user, and `userId` is required as of this chapter, so the
      // condition could no longer be false. **Fourth time this project has met a guard
      // that stopped meaning anything**: `addMember`'s `rowCount ?? 0`, and
      // `upsertUser`'s second throw and `(row.metadata ?? {})`. Tightening a
      // type makes its runtime guards dead; three of the seven `userId` comparisons in
      // this file were dead the moment T012 landed, and two others are in methods where
      // the parameter is optional by design and must not be touched.
      //
      // A BOT CAN BE BANNED, AND THAT IS THE POINT (FR-005c). `banned_at` has been on
      // every `users` row since the channel-control chapter and this check has never run for a bot
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
          // `channels.type` has been a `"public" | "private"` column
          // with a CHECK since chapter 2.1 and nothing decided on it until now — it
          // was returned by the create route and consulted by nothing.
          type: channels.type,
          // Declared in chapter 2.1 and read by NOTHING until here:
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

      // MEMBERSHIP, FOR A PRIVATE CHANNEL, WHEN A USER IS SENDING
      // (FR-001, FR-CHN-05).
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
      // And that gate is only honest because the channel-control chapter made the public route
      // supply a user. It called `messages.send(channelId, body)` with none, and
      // `MessagesController` declared no `@Accepts` at the time — so the guard fell
      // back to `EITHER` and a user token was accepted there. the sender chapter declared it;
      // the third of three copies of this sentence, all corrected in the revisions chapter. A
      // check gated on a parameter no caller fills in is a check that never fires, and
      // this one did not, on the only send path a customer's own client uses.
      //
      // `ChannelNotFoundError` AND NOT A 403. SC-002 requires the answer for a
      // private channel the caller cannot see to be byte-identical to a channel
      // that does not exist — same status, same body but for `request_id` — and
      // send is one of the verbs it covers. A `403 not_a_member` here would
      // announce that the channel exists, which is the leak FR-003 forbids and
      // exactly what the isolation harness's indistinguishability oracle was built to
      // catch. The refusal above throws the same error for the same reason.
      //
      // FR-021a's ORDER is ban, then membership and visibility, then archive. The
      // ban goes ahead of the channel read entirely, so a banned user gets one
      // answer for every channel id; the archive check goes below this one, so a
      // non-member of a private archived channel never learns it exists from
      // `channel_archived`. Both arrive with their own columns' chapters; this is
      // the middle of the three.
      // THE SENDER ATTRIBUTES; IT DOES NOT AUTHORISE (FR-019).
      //
      // This gate used to read `channel.type === "private" && userId !== undefined`,
      // and the second half was doing real work: a key-authenticated send carried no
      // user, so it skipped the membership check entirely. That is the channel-control chapter's
      // FR-005 — an application credential "acts for the customer, carries no user,
      // and sees private channels" — and `messages.itest.ts` asserts it by name.
      //
      // Requiring `userId` would have made the condition always true, fired the check,
      // and refused a bot that is not a member with `ChannelNotFoundError`: a 404 that
      // by design cannot say why. A capability the channel-control chapter delivered would have
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

      // THE SENDER'S KIND, FOURTH OF THE FIVE (FR-007, T032).
      //
      // After the ban and the visibility, because this refusal names a fact about a
      // USER — "that identifier is a person" — and a caller who could not otherwise
      // reach this channel must not be able to ask it. Same reasoning as
      // archive-after-visibility below, one subject over.
      //
      // BEFORE THE ARCHIVE CHECK, AND THAT PAIR IS THE ONE ORDERING HERE THAT DOES NOT
      // MATTER. Both of these refusals are addressed to a caller who has already been
      // shown the channel exists, and each names something that caller already knows —
      // the identifier it chose, or a state it can read. Swapping them changes which
      // code an integrator sees first and leaks nothing either way. Said explicitly
      // because every other adjacency in this sequence is load-bearing, and a reader
      // who finds one that is not should be told rather than left to test it.
      //
      // `senderIsPerson` was computed at the ban check from the same row, so this costs
      // nothing beyond the comparison.
      if (senderMustBeBot && senderIsPerson) {
        throw new SenderNotPermittedError(userId);
      }

      // ARCHIVE, AFTER VISIBILITY AND NOT BEFORE (FR-020, FR-021,
      // FR-021a).
      //
      // The order is the requirement, not an implementation detail. Put this check
      // above the membership one and a non-member of a private ARCHIVED channel
      // learns it exists from `channel_archived` — a refusal that reveals what it is
      // refusing, which is the defect the isolation harness's fifth analysis pass caught one
      // phase before shipping.
      //
      // So: ban, then membership and visibility, then archive. The ban's slot is
      // ahead of the channel read entirely — a banned user gets one answer for every
      // channel id, including ids that do not exist — and it is EMPTY here on
      // purpose: `users.banned_at` has no reader until the user-surface chapter gives it one at
      // T155a. Leaving the slot visible is the point; a reader who finds two checks
      // where the requirement names three should be able to see which is missing.
      //
      // History stays readable while archived (FR-020). Only the write refuses.
      if (channel.archivedAt !== null) throw new ChannelArchivedError(channelId);

      // THE CAP, CHECKED BEFORE THE MESSAGE IS WRITTEN (FR-RTL-08).
      //
      // Here rather than in middleware, because the rate-limit chapter's limiter never sees
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

      // FR-MED-06, LAST AMONG THE REFUSALS AND STILL INSIDE THE TRANSACTION (FR-011).
      //
      // AFTER THE BAN, THE CHANNEL AND THE QUOTA, for the reason the ban's own comment
      // gives about order: a refusal naming a fact about a resource must not be reachable
      // for a caller who could not otherwise get this far. Everything above has already
      // established that this sender may write to this channel, so a media refusal here
      // tells them only about objects in their own environment — which is what the
      // predicate is scoped to anyway.
      //
      // BEFORE THE INSERT, which is the half SC-003 asserts: nothing is written, no
      // outbox row is queued, and `channels.last_sequence` does not move. The sequence is
      // computed on the next line and a refusal never reaches it.
      await this.assertAttachableMedia(tx, attachments, userId, senderMustBeBot);

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
      // AND `lastActivityAt` MOVES IN THE SAME STATEMENT (FR-014).
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

      // THE EVENT COMMITS WITH THE MESSAGE (ADR-06).
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
          // FR-015 and FR-017. The same list the row holds and the frame carries — a
          // consumer and a socket client comparing the two see one message.
          attachments: attachments ?? [],
          created_at: createdAt,
        },
      });
      await tx.insert(outbox).values({
        subject: event.subject,
        payload: event.payload,
      });

      // THE MONTH'S USAGE COMMITS WITH THE MESSAGE (FR-RTL-05).
      //
      // Same argument as the event above it, one requirement further on. A quota
      // is about THIS MONTH and must not forget, so the count cannot live in the
      // per-minute counter store the rate-limit chapter built — a flush there costs one
      // window of over-service, a flush here costs the month. A quota must survive
      // the counter store.
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

      // The distinct-user count.
      // UNCONDITIONAL, AND THE GUARD THAT WAS HERE COULD NOT BE FALSE. It read
      // `if (userId !== undefined)`, with a comment saying a key-authenticated REST
      // send carries no `userId` and so counts toward the message quota and toward no
      // user. That was true of a platform where the parameter was optional; the sender
      // chapter made it REQUIRED — `userId: string`, and its own comment says required
      // is the whole mechanism, because SC-003 asks that no write path be able to
      // produce a senderless message.
      //
      // So there is no unattributed send left to guard against, and the arm was one
      // the type system forbids. Deleted rather than covered, which is what this
      // repository does with an unreachable arm — and the deletion is also the more
      // honest statement: every message counted here has a sender, and the distinct-user
      // count is exactly the senders.
      //
      // A row rather than a counter, and that has not changed: incrementing one would
      // need to know whether this user already sent this period, which is a read. The
      // row IS the answer, and `ON CONFLICT DO NOTHING` makes the second send of the
      // month free.
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
        /** WHAT WAS SENT, AND THE INSERT IS NOT ENOUGH ON ITS OWN.
         *
         * T022 wrote the column and this line is a separate change: analysis pass 9
         * found that nothing in the plan made this return carry the field, and the 201
         * response and both fan-out payloads read it from here. `?? []` because the
         * parameter is optional and FR-007 says a message with none is RETURNED with an
         * empty list. */
        attachments: attachments ?? [],
        created_at: createdAt,
      };
    }),
    );
  }

  /** Change what a message says (FR-001, FR-002, FR-003, FR-004).
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
    // FR-MED-07: decorated AFTER the transaction commits. The media state is not
    // part of this write and reading it on the transaction's own connection would
    // tie one fact's freshness to another's commit. One extra statement.
    return this.withMediaState(
      await this.db.transaction(async (tx) => {
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
          /** (FR-015, FR-016). THIS READ CHANGES, AND T053's LIST OF FOUR
           * BECOMES THREE.
           *
           * An edit does not change attachments — T045 and T046 prove that from both
           * sides — but the `message.updated` event and the 200 response must carry the
           * ones the message ALREADY has, and neither can invent them. So the read that
           * feeds both selects the column. */
          attachments: sql<Attachment[] | null>`${messages.attachments}`,
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
      // THE WRITE REFUSES, NOT ONLY THE READ (feature 043, FR-007).
      //
      // This was `.where(eq(messages.id, messageId))`, and the `row.text === null`
      // check above it is a read taken earlier in the same transaction. Neither this
      // method nor `deleteMessage` takes a row lock, so a deletion committing in that
      // window left the edit free to overwrite it: `text` restored, `deleted_at` still
      // set — **a row one filter calls deleted and another calls alive**, and a
      // deletion that returned successfully undone by an edit already in flight.
      //
      // `gaps.md` 3.23-3 recorded the opposite — *"both interleavings end in a
      // tombstone… there is no order of the two that leaves a message saying something
      // nobody wrote"* — and the test that item asked for is what disproved it: three
      // of five runs, and four incoherent rows left behind in the lane.
      //
      // A COMPARE-AND-SET, NOT A LOCK. `SELECT … FOR UPDATE` in both methods would
      // close it too, and would serialise a pair `assertWithinQuota` deliberately
      // declined to serialise on the send path. A conditional UPDATE costs nothing
      // when there is no race and refuses exactly when there is one: zero rows
      // affected means the row stopped being editable between the read and the write,
      // which is what `MessageDeletedError` already says.
      const [updated] = await tx
        .update(messages)
        .set({ text, editedAt: sql`now()` })
        .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
        .returning({ editedAt: messages.editedAt });
      if (!updated) throw new MessageDeletedError(messageId);
      const editedAt = updated.editedAt!;

      // FEATURE 044, FR-002/FR-003. The channel's revision counter rises by one, inside the
      // transaction that applies the revision — so a revision that commits and a count that
      // rises are the same event, and a count can never describe a revision the transaction
      // refused.
      //
      // AFTER THE COMPARE-AND-SET ABOVE, deliberately. That statement refuses an edit to an
      // already-deleted message by affecting zero rows; bumping before it would raise the
      // count for an edit that then threw.
      //
      // AN EXTRA ROUND TRIP, AND THE RIGHT SIDE OF THE TRADE. The send path updates this row
      // anyway, so `lastActivityAt` there "costs an extra assignment rather than an extra
      // round trip"; this path touches `messages` and `message_edits` only, so the counter
      // costs one UPDATE. Revisions are rare and reconnects are not, and the alternative puts
      // a scan on the handshake (FR-014).
      await tx
        .update(channels)
        .set({ revisionSequence: sql`${channels.revisionSequence} + 1` })
        .where(eq(channels.id, channelId));

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
        // CHAPTER 4.19. This row's text stopped being current because a later edit
        // replaced it — which was the only way a row got here until this chapter, and
        // is now one of two. The backfill in `0022` wrote `'edit'` on all 4,863
        // existing rows for the same reason.
        endedBy: "edit",
      });

      // THE EVENT COMMITS WITH THE EDIT (FR-019, ADR-06). Same argument
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
          // FR-015: identical to the creation payload, so a consumer needs one shape for
          // both. An edit does not change attachments (FR-016), so these are the ones the
          // message already had — which is why phase 7 widened this read.
          attachments: row.attachments ?? [],
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
        // WHAT THE MESSAGE ALREADY HAS. `?? []` for the same reason every read has one:
        // the column holds NULL for a message with none and FR-007 says a reader sees an
        // empty list.
        attachments: row.attachments ?? [],
        created_at: toIso(row.createdAt),
        edited_at: toIso(editedAt),
        prior_text: row.text,
      };
    }),
    );
  }

  /** Turn a message into a tombstone (FR-006, FR-006a, FR-009).
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
   * feature with a retention policy rather than a line in this method. the revisions chapter's
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
      // read path already branches on. the channel-control chapter's planted tombstone sets both.
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

      // CHAPTER 4.19, FR-001. THE TEXT THE MESSAGE HELD WHEN IT WAS REMOVED.
      //
      // Until this line a deletion wrote nothing here, so a message deleted after N
      // edits left N recoverable texts out of the N+1 that existed and a message
      // deleted with no edits left zero of one. FR-MOD-01 asks for a complete history
      // and FR-MSG-08 reserves hard deletion for the compliance endpoint; losing the
      // last version at a moderation delete was a hard deletion on the wrong path.
      //
      // ON THIS BRANCH ONLY, which is FR-004 and the same half of FR-009 the event
      // insert below turns on: a repeated deletion returned above without writing, so
      // it records no second final version. The count is what proves it — three rows
      // after the first delete and three after the second, not a delta of zero, which
      // nothing happening also satisfies.
      //
      // THE INSTANT IS THE ROW'S, NOT A SECOND READING. `updated!.deletedAt!` is the
      // value the database assigned and the `.returning()` handed back, and the
      // tombstone, the frame, the outbox event and this row therefore all quote one
      // timestamp. `editMessage` states the same rule 280 lines up and gives the
      // reason: the history row's own primary key is `(message_id, edited_at)`, so a
      // caller matching an entry to the message state that produced it needs the two
      // to be equal. A fresh `now()` here would be a different microsecond and the
      // match would fail silently.
      //
      // `row.text` IS NARROWED TO A STRING by the early return above — the branch that
      // sends an already-deleted message back tests `row.text === null` — so
      // `prior_text NOT NULL` is never offered a null, including for the system
      // messages with no text that `deleteMessage`'s own comment contemplates.
      // `sql`now()`` AND NOT `updated!.deletedAt!`, AND A TEST FOUND THE DIFFERENCE.
      //
      // Both express the same instant — `now()` is `transaction_timestamp()` and is
      // stable across this transaction, so this row and the tombstone's `deleted_at`
      // are the same value by construction. What differs is PRECISION. The column is
      // `timestamptz` at precision 6 and the value that came back through the driver
      // is a JavaScript `Date`, which holds MILLISECONDS — so writing it back
      // truncates, and the primary key `(message_id, edited_at)` gets a collision
      // window a thousand times wider than the column can represent.
      //
      // Measured: `repository.itest.ts`'s concurrent edit-and-deletion race failed on
      // attempt 1 of 10 with `23505 … Key (message_id, edited_at)=(…, 11:10:28.806+00)
      // already exists`, and the deletion's whole transaction rolled back — the
      // message was left un-tombstoned by a concurrent edit, which is FR-007's
      // property broken by this chapter's own insert.
      //
      // AND THE TABLE SAYS HOW LONG THAT HAS BEEN TRUE OF THE EDIT PATH: 5,149 of
      // 5,149 existing rows are millisecond-exact on a microsecond column, because
      // every value ever written here came from JavaScript. `schema.ts` claimed the
      // key needed "two edits inside one microsecond"; it needed two inside one
      // millisecond, and that comment is corrected.
      await tx.insert(messageEdits).values({
        messageId,
        editedAt: sql`now()`,
        priorText: row.text,
        endedBy: "deletion",
      });

      // FEATURE 044, FR-002/FR-003. A DELETION IS A REVISION and raises the count exactly as
      // an edit does — US1's third acceptance scenario fails if only edits are counted. Same
      // transaction, same argument as the edit path.
      await tx
        .update(channels)
        .set({ revisionSequence: sql`${channels.revisionSequence} + 1` })
        .where(eq(channels.id, channelId));

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

      // FR-MOD-03, AND ONLY WHEN A TENANT KEY DID IT (FR-002a). This is the one route
      // whose classification the credential decides: `moderation-when-application`.
      //
      // THE CONDITION IS THE ACTOR'S KIND, NOT `userId === undefined`. The two agree
      // today — the controller passes the user only for a user token — but they are
      // different claims, and the one the audit log is entitled to is who authenticated
      // the request. Reading the parameter would make the entry depend on a calling
      // convention rather than on a credential.
      //
      // On this branch only, like the event above: a repeated deletion returned before
      // reaching here, so a client retrying a 204 writes no second entry.
      if (this.actorKind === "application") {
        await this.recordAction(tx, {
          action: ACTION.deleteMessage,
          targetKind: "message",
          targetId: messageId,
        });
      }

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

  /** A message's edit history, oldest first (FR-023).
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
  ): Promise<
    Array<{
      prior_text: string;
      edited_at: string;
      ended_at: string;
      ended_by: string;
    }>
  > {
    const rows = await this.db
      .select({
        priorText: messageEdits.priorText,
        editedAt: messageEdits.editedAt,
        endedBy: messageEdits.endedBy,
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
    // `edited_at` AND `ended_at` CARRY THE SAME VALUE, DELIBERATELY (chapter 4.19).
    //
    // One column, two names, because `edited_at` is published and cannot be removed
    // without a breaking change under CON-05 — and it is the wrong word for a row whose
    // text ended in a deletion. `ended_at` is the right word and is additive. The
    // duplication is one field wide, it is the price of not versioning a route over a
    // noun, and it is stated in `contracts/message-versions.md` so nobody has to work
    // out which of two names to trust. A client should read `ended_at` and `ended_by`;
    // `edited_at` is kept for callers written before this chapter.
    //
    // The array key stays `edits` where `versions` would read better, for the same
    // reason and at the same price.
    return rows.map((r) => ({
      prior_text: r.priorText,
      edited_at: toIso(r.editedAt),
      ended_at: toIso(r.editedAt),
      ended_by: r.endedBy,
    }));
  }

  /** Does this message exist in this channel of this tenant?
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

  /** Refuse the send if a hard cap is already met (FR-RTL-08).
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
  /** FR-MED-06's predicate, asked of the rows rather than reasoned about (FR-002 to
   * FR-005, FR-010, FR-011).
   *
   * INSIDE THE CALLER'S TRANSACTION, WHICH IS FR-011 AND NOT A PREFERENCE. `tx` is passed
   * in rather than `this.db` used, so the read and the insert that follows it are one
   * unit: a refusal writes no message row, no outbox row and does not advance the
   * channel's sequence, and an object deleted a millisecond after the check cannot leave
   * a message pointing at nothing.
   *
   * ONE QUERY AND NOT N, WITH THE DIFFERENCE TAKEN IN ORDER. A lookup per attachment
   * would be up to ten round trips inside a write transaction for a question one `IN`
   * answers. What the single query costs is that "which one failed" becomes a set
   * difference — and the difference has to preserve POSITION, because the refusal's
   * `field` is `attachments.<n>.media_id`. `wanted` carries the index alongside the id
   * for exactly that reason, and the first gap in order is the one reported.
   *
   * THE THREE CLAUSES, IN THE CLAUSE'S OWN ORDER (`data-model.md` §2):
   *
   *     environment_id = this tenant                       FR-002
   *     AND (the caller is an application credential
   *          OR user_id IS NULL                            the tenant uploaded it
   *          OR user_id = the sending user)                FR-003
   *     AND state IN ('pending', 'ready')                  FR-010
   *
   * A NULL `user_id` PASSES FOR A USER TOKEN, and the specification assumed the
   * opposite. It means an API key took the slot — the tenant's own backend — and 4.10's
   * controller wrote the column nullable for this question: *"a photo sent by a person
   * and an attachment uploaded by a customer's backend are the same operation."* Under
   * the strict reading they are not the same at all: one produces an object any user of
   * the tenant can attach and the other produces one nobody can, which makes the
   * nullability pointless because any sentinel would do.
   *
   * `state IN ('pending', 'ready')` IS WRITTEN IN FULL AND BOTH ARMS NOW OCCUR. 4.10's
   * CHECK constraint was `state = 'pending'`, so for two chapters `'ready'` was
   * unreachable and this comment said so, adding that a predicate naming one arm *"would
   * have to be found and widened by whoever builds the scanner."* Migration `0018` widens
   * the constraint to the three states and nothing here needed widening — which is the
   * only reason that sentence was worth writing. It is corrected rather than left
   * standing: a comment describing behaviour no code performs is the defect this movement
   * has now found in `store.ts`, in `docs/07` §6, in `docs/12` row 11 and in a test's
   * deadline.
   *
   * AND `'rejected'` IS OUTSIDE THE SET, WHICH IS FR-MED-06's REFUSAL ARRIVING FOR FREE.
   * The predicate was written against a three-state world before that world existed, so
   * a verified-bad object becomes unattachable with no clause added — the set was always
   * "the two states an attachment may be in", and the third one just started happening.
   *
   * CONSTITUTION VI ASKS FOR 100% BRANCH COVERAGE OF TENANT ISOLATION, AND THIS IS THAT
   * CLAUSE MET RATHER THAN PINNED — with the per-arm evidence, because the percentage
   * cannot carry it. `repository.ts` is pinned at 92 branches and measures 92.91 across
   * hundreds of them, so an uncovered arm HERE would pass the ratchet with room to spare.
   * The pin is not the instrument; each arm was deleted and the suite re-run:
   *
   *     the three SQL clauses      no JavaScript branch at all. 048 recorded the same
   *                                clause as unmeasurable for a sorting key; a WHERE is
   *                                the same shape from a different direction.
   *                                RE-RUN AT 4.13 rather than inherited, because the
   *                                original run was made when only one state could
   *                                occur, and it is no longer true. Deleting the
   *                                whole clause -> ONE red, the `rejected` refusal.
   *                                Narrowing it to `['pending']` -> ONE red, the
   *                                `ready` attach. Both arms are now separately
   *                                covered, where at 4.11 neither could be: the
   *                                recorded result was about a platform that has
   *                                stopped existing.
   *     `senderMustBeBot ? …`      forced to the user predicate -> exactly ONE test red,
   *                                "lets an API key attach a USER's object". Nothing else
   *                                moved, and that is the finding: an API key's own slot
   *                                records `user_id IS NULL`, which the user predicate
   *                                admits — so a suite without that one case would have
   *                                passed with this arm deleted.
   *     `refused !== undefined`    never fires -> five red, every refusal test.
   *     `wanted.length === 0`      deleted -> **17 of 17 still pass.** It is an
   *                                optimisation and not a behavioural branch: with no
   *                                media the `IN` is empty, nothing comes back, and
   *                                nothing is refused. Kept because most sends carry no
   *                                media and none of them should pay a round trip.
   *
   * A COVERAGE NUMBER WOULD HAVE CALLED ALL FOUR "COVERED" and told nobody that one of
   * them does nothing observable.
   *
   * A ROW THAT DOES NOT MATCH AND A ROW THAT DOES NOT EXIST ARE THE SAME OUTCOME
   * (FR-005). The query returns what passes; anything asked for and not returned is
   * refused, with no way for the caller — or for this method — to tell which clause it
   * failed or whether the row is there at all. */
  private async assertAttachableMedia(
    tx: Db,
    attachments: Attachment[] | undefined,
    senderUserId: string,
    /** `senderMustBeBot`, THREADED UNCHANGED, AND THE ALTERNATIVE IS THE VIOLATION.
     *
     * The predicate needs one fact — whether the caller is an application credential —
     * and `sendMessage` already takes it under a name about the SENDER. Passing a second
     * boolean called `callerIsApplication` would read better here and would be the thing
     * research R5 forbids: *"the repository must not learn what a credential is."* Two
     * booleans that are always equal is also two things to keep in step. So the existing
     * constraint is reused and the mismatch between its name and this use is written
     * down rather than hidden — a send whose sender must be software is, in this
     * platform, exactly a send an application credential made. */
    senderMustBeBot: boolean,
  ): Promise<void> {
    const wanted = (attachments ?? []).flatMap((attachment, index) =>
      attachment.type === "media" ? [{ index, id: attachment.media_id }] : [],
    );
    if (wanted.length === 0) return;

    const attachable = await tx
      .select({ id: mediaObjects.id })
      .from(mediaObjects)
      .where(
        and(
          inArray(
            mediaObjects.id,
            wanted.map((w) => w.id),
          ),
          eq(mediaObjects.environmentId, this.environmentId),
          senderMustBeBot
            ? undefined
            : or(
                isNull(mediaObjects.userId),
                eq(mediaObjects.userId, senderUserId),
              ),
          inArray(mediaObjects.state, ["pending", "ready"]),
          // 4.15: A RENDITION IS NOT ATTACHABLE (FR-004), AND IT WOULD HAVE BEEN.
          //
          // A thumbnail is `ready` and belongs to the environment, so it satisfies every
          // condition above and a sender who learned its id could attach it. It is not a
          // thing a client uploaded and it is not a thing a message should name: the
          // message names the parent, and the rendition rides along on delivery.
          //
          // IN THIS PREDICATE RATHER THAN BESIDE IT, so the refusal is the one arm this
          // function already produces. A separate check with its own error code would
          // tell a caller that somebody else's rendition exists, which is precisely what
          // FR-MED-06's three-conditions-one-answer rule forbids.
          isNull(mediaObjects.parentId),
        ),
      );

    const passed = new Set(attachable.map((row) => row.id));
    // IN ORDER, so ten attachments with the third one foreign name the third. `find`
    // walks `wanted`, which was built by walking the array the caller sent.
    const refused = wanted.find((w) => !passed.has(w.id));
    if (refused !== undefined) throw new MediaNotAttachableError(refused.index);
  }

  private async assertWithinQuota(
    tx: Db,
    period: string,
    /** `string`, NOT `string | undefined`, and the narrowing is the sender chapter's.
     * Its one caller is `sendMessage`, whose `userId` is required — so the optional
     * type here bought an arm nothing could take, and the arm below it read
     * `users_.hard === null || userId === undefined`. Second dead `userId` comparison
     * this chapter's port has met; the first was the distinct-user insert's guard. */
    userId: string,
    /** WHETHER THE SENDER IS A PERSON, computed at the ban check from the same row so
     * this costs nothing beyond passing it. It decides the ENFORCED ceiling and not the
     * bill — see the two notes below, which are the two halves of one exemption. */
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

    // A BOT IS EXEMPT FROM THE CEILING, AND BILLED FOR THE SEND (FR-RTL-05 as this
    // project's own SRS amendment left it). The clause caps "unique active PERSONS";
    // FR-ANL-05 still meters "unique active users", and the insert in `sendMessage`
    // counts a bot like anyone — which is what makes a bot billed and exempt at once.
    //
    // THE REASON IS WHOSE SEND GETS REFUSED. The ceiling bounds a customer's human
    // population, and a customer's own software must not be able to lock their people
    // out of sending. It would: the block below refuses the FIRST send of a period by
    // anyone once the count is reached, so the person refused is never whoever caused
    // it.
    if (!senderIsPerson) {
      return { caps: { messages: messages_, active_users: users_ }, sent };
    }
    // NO CAP ON USERS, NOTHING MORE TO CHECK. The `|| userId === undefined` that stood
    // beside this is gone with the parameter's type: a send with no sender is a state
    // no write path can produce since the sender chapter made `userId` required.
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

    // AND THIS IS THE EXEMPTION'S SECOND HALF, which is the one that decides whether
    // it works. Returning early above is visible: a bot's send is not refused. But the
    // count the ceiling compares against would still hold the bot's row, displacing a
    // person — so a customer at a ceiling of five with two bots could seat three
    // people. **A test that only watches a bot's send succeed passes with the first
    // half alone**, which is why the one below sends as a PERSON after a bot.
    //
    // THE JOIN FILTERS `kind` AND NOT `deleted_at`, and the wrong version is the one a
    // careful reader writes: three `users` joins in this file pair with
    // `isNull(users.deletedAt)` and it is the house idiom. `deleteUser` is a SOFT
    // delete and leaves `usage_active_users` alone, so adding that filter would make a
    // deleted person's row stop counting — and deleting users would become a way to
    // free ceiling slots, which it is not.
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

  /** Write a row for each threshold a usage increase crossed (FR-RTL-07).
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
    // FR-MED-07: the same decoration every other read does. An idempotent retry gets
    // the state the object is in NOW, not the state it was in when the first send
    // committed — which is the point of reading it at serve time.
    return this.withMediaState({
      ...row,
      // FR-007's `?? []`, AT THE READ. The column holds NULL for a message with no
      // attachments and `[]` is what a client gets, so exactly one place converts.
      // `?? []` and not `|| []`: an empty array is falsy to neither, but the habit of
      // `||` here is how a `0` or a `""` becomes a default somewhere else.
      attachments: row.attachments ?? [],
      created_at: toIso(row.created_at),
    });
  }

  /** Does this channel resolve IN THIS TENANT? (chapter 2.8.)
   *
   * The write path has asked since 2.2 — it needs the channel row to lock —
   * so it answers a foreign id with a 404. The read path never asked: a
   * tenant-scoped query over a foreign channel simply returns no rows, and
   * the endpoint dressed that as an empty page. The milestone suite caught
   * the two doors disagreeing about the same resource. */
  /** One channel by its id, scoped, with the two fields the by-id route reports
   * beyond FR-CHN-01's four (FR-003a).
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

  /** Whether this user is a member of this channel.
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

  /** Whether this channel exists AND this caller may see it (FR-003).
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

  /** The `object_key` of a media object this caller may read, or `undefined` (FR-MED-08).
   *
   * Three questions, and each refusal is the same refusal: does this environment own an
   * object with that id, which of this environment's channels carry a message referencing
   * it, and may this caller see any of them.
   *
   * TWO QUERIES AND NOT ONE, WHICH IS THE OPPOSITE OF WHAT THE PLAN SAID. The design this
   * chapter was planned with was a single three-way join — `media_objects` to `messages`
   * on containment to `channels` — and it is the shape that makes the new GIN index
   * unusable. The containment operand is built from `o.id`, a value from the other side of
   * the join, so the planner cannot look it up; it narrows to the tenant's channels and
   * applies containment as a join filter over every message they hold. Measured on the
   * lane's busiest tenant, 1,018 messages:
   *
   *     one joined query, a hit     Nested Loop, `Rows Removed by Join Filter: 1017`
   *                                 86 buffers · 1.109 ms · the index unused
   *     two queries, a hit           3 + 17 buffers · 0.034 + 0.077 ms
   *                                 `Bitmap Index Scan on messages_attachments_gin`
   *
   * Splitting it makes the containment operand a bound value, which is the only form the
   * index can serve. The scope survives the split — step two still names this environment
   * — and so does the reason for reading the object row at all: `object_key` is what
   * `presign` signs, and reading it is what makes the object's own `environment_id` a
   * check this route performs rather than one it inherits from the send path.
   *
   * AND THE SMALL TENANT HID IT. The same one-query plan costs 14 buffers on a
   * nine-message environment, which is what the analysis passes measured. Its cost is the
   * tenant's message count; the two-query cost is not.
   *
   * `channelVisibleTo` IS REUSED RATHER THAN REWRITTEN, and that is FR-MED-08's note
   * being satisfied by construction. The clause says media access "inherits channel
   * membership rather than inventing a parallel ACL system" — a second predicate written
   * here would be a parallel ACL however faithfully it copied the first. It also answers
   * the clause's own "or API key" arm, because `userId === undefined` means the tenant is
   * reading and sees everything it owns.
   *
   * AND READING THE CLAUSE LITERALLY WOULD HAVE BEEN STRICTER THAN THE MESSAGE. FR-MED-08
   * says "channel membership"; this platform checks membership for `private` channels
   * only, so a membership test would refuse a user the photo in a message whose text they
   * can read. 11,557 public channels against 1,016 private on this lane. */
  async readableMediaObjectKey(
    mediaId: string,
    userId?: string,
  ): Promise<string | undefined> {
    const [object] = await this.db
      .select({
        objectKey: mediaObjects.objectKey,
        // 4.15: null for an upload, the parent for a rendition. Fetched in the statement
        // that already reads this row rather than by a second lookup, for the reason the
        // verdict's own `RETURNING` list gives — a second read can disagree with the first.
        parentId: mediaObjects.parentId,
      })
      .from(mediaObjects)
      .where(
        and(
          eq(mediaObjects.id, mediaId),
          eq(mediaObjects.environmentId, this.environmentId),
          // ADR-14's DELIVERY GATE: NO SIGNED URL UNTIL `ready` (FR-012).
          //
          // A FOURTH CONDITION AND THE SAME ANSWER. An object still under verification
          // and an object the scanner refused both answer exactly as a foreign one and
          // an absent one do — the caller learns that they cannot have it and nothing
          // about why, which is the same discipline the three conditions above were
          // written with.
          //
          // AND IT COULD NOT HAVE SHIPPED ALONE. `research.md` R4 measured this clause
          // against 4.12's route BEFORE the state machine existed: **10 of 76 tests
          // red**, including the isolation gauntlet's own control, because
          // `media_objects_state_check` permitted one value and no object could ever
          // be `ready`. The transition and the gate ship together or the gate ships
          // broken — which is why this line is in the verification chapter and not in
          // the one that built the route.
          eq(mediaObjects.state, "ready"),
        ),
      );
    if (!object) return undefined;

    // FR-MED-05: A RENDITION IS AUTHORISED THROUGH ITS PARENT, BY THE SAME PREDICATE.
    //
    // A thumbnail is named by no message — the message names the parent — so
    // `channelsReferencingMedia` returns nothing for it and the loop below refuses it.
    // **That is FR-MED-08 working exactly as written**, not a bug: an object with no
    // referencing message is readable by nobody, including whoever uploaded it. What
    // FR-MED-05's "sharing the parent's lifecycle" adds is that a rendition's
    // reachability IS the parent's, so the question is asked about the parent instead.
    //
    // **ONE SUBSTITUTION, NOT A SECOND PREDICATE.** FR-005 requires the authorisation to
    // be the same predicate rather than a copy of it, so this changes which id the
    // existing loop asks about and changes nothing else. A copy would be the third
    // tenancy scope 4.12 found whose individual removal turned nothing red.
    //
    // The state condition above already applied to the row that was fetched: a rendition
    // is `ready` by `media_objects_rendition_state_check`, and a rendition of a parent
    // that never reached `ready` cannot exist, because generation runs after the verdict
    // that would refuse it.
    const authorisingId = object.parentId ?? mediaId;
    for (const channelId of await this.channelsReferencingMedia(authorisingId)) {
      if (await this.channelVisibleTo(channelId, userId)) return object.objectKey;
    }
    return undefined;
  }

  /** Every channel of this environment holding a message that references this object.
   *
   * EVERY REFERENCING CHANNEL, NOT THE FIRST AND NOT EVERY REFERENCE. FR-MED-08's
   * singular — "the referencing message" — does not describe this platform: FR-MSG-11 has
   * allowed the same id twice since 3.24, and forwarding a photo is the ordinary way one
   * object acquires a second reference. Authorisation is a disjunction over them, so a
   * query that stopped at the first row would refuse a caller whose channel happened to be
   * second — a correctness bug that presents as flakiness.
   *
   * `DISTINCT` BOUNDS IT BY CHANNEL. A photo forwarded into one channel a hundred times is
   * one authorisation question, not a hundred, and a private channel costs two queries per
   * question rather than one.
   *
   * SCOPED HERE AND NOT ONLY IN THE CALLER. `channelVisibleTo` refuses another tenant's
   * channel afterwards, so the predicate below is redundant for correctness — and without
   * it this is the only read in this file that would scan every tenant's rows. A query
   * whose safety depends on a later call is a query somebody will reuse without it. */
  /** FR-MED-07's first sentence: an attachment is served with the state its object is
   * in **right now**, not the state it was in when the message was sent.
   *
   * **TWO QUERIES PER PAGE AND NOT ONE PER ROW.** The obvious shape is a correlated
   * subquery that decorates each row's jsonb, which is one lookup per message per
   * attachment; 4.12 measured what that costs on the read path — 1,042 buffers against
   * 84 — and the repair was to make the operand a value the planner already has. Here
   * the whole page's media ids are collected first and fetched with one `= any(...)`
   * against the primary key, scoped by environment. A fifty-message page costs one extra
   * statement, whatever it attaches.
   *
   * **THE STATE IS NOT STORED ON THE MESSAGE, AND THAT IS FR-002 RATHER THAN A
   * SHORTCUT.** `messages.attachments` holds what the sender declared. Writing a state
   * into it would make every verdict a write across every referencing message and give
   * one fact two homes, which is constitution IV.
   *
   * An id with no row — an object erased between the message being read and this
   * query — is served as `pending`, because the alternative is dropping the attachment
   * and a reader would see a message that never had it. FR-MED-10 destroys unreferenced
   * objects, and a referenced one is not among them. */
  private async withMediaStates<T extends { attachments: Attachment[] }>(
    rows: T[],
  ): Promise<(Omit<T, "attachments"> & { attachments: DeliveredAttachment[] })[]> {
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          row.attachments.filter((a) => a.type === "media").map((a) => a.media_id),
        ),
      ),
    ];
    const states = new Map<string, MediaState>();
    /** FR-MED-05: the parent's rendition, if it has one. */
    const thumbnails = new Map<
      string,
      { media_id: string; width: number; height: number }
    >();
    if (ids.length > 0) {
      const found = await this.db
        .select({ id: mediaObjects.id, state: mediaObjects.state })
        .from(mediaObjects)
        .where(
          and(
            inArray(mediaObjects.id, ids),
            // THE TENANT PREDICATE, on a lookup by primary key that does not need it to
            // return the right rows — and constitution I is about the layer, not about
            // whether a given query could get away without it.
            eq(mediaObjects.environmentId, this.environmentId),
          ),
        );
      for (const row of found) states.set(row.id, row.state as MediaState);

      // THE RENDITIONS OF THIS PAGE'S OBJECTS — a THIRD query per page, not a second
      // per row, and not a join.
      //
      // **WHY NOT A JOIN ON THE QUERY ABOVE.** A left join to the same table on
      // `parent_id` would return one row per (object, rendition) pair and make the
      // `states` map above a group-by in Node. One more `= any(...)` over the partial
      // index `media_objects_parent_idx` is cheaper to read and, measured on this
      // lane, indistinguishable to run. 4.12's rule is about the OPERAND being a bound
      // value, which both shapes satisfy; the cost it warned about was a correlated
      // subquery per row, which neither is.
      //
      // SAME TENANT PREDICATE, FOR THE SAME REASON. `parent_id` is already constrained
      // to this environment by `media_objects_parent_fk`, so this clause cannot change
      // the result — and 4.12 found three tenancy scopes whose individual removal
      // turned nothing red, which is exactly what a clause that cannot change a result
      // looks like from a test suite.
      const derived = await this.db
        .select({
          id: mediaObjects.id,
          parentId: mediaObjects.parentId,
          width: mediaObjects.width,
          height: mediaObjects.height,
        })
        .from(mediaObjects)
        .where(
          and(
            inArray(mediaObjects.parentId, ids),
            eq(mediaObjects.rendition, "thumbnail"),
            eq(mediaObjects.environmentId, this.environmentId),
          ),
        );
      for (const row of derived) {
        // A rendition without dimensions cannot be offered: the whole point of sending
        // it is a box the client can reserve, and `{media_id}` alone would make a
        // caller fetch the bytes to find out how big they are.
        if (row.parentId && row.width !== null && row.height !== null) {
          thumbnails.set(row.parentId, {
            media_id: row.id,
            width: row.width,
            height: row.height,
          });
        }
      }
    }
    return rows.map((row) => ({
      ...row,
      attachments: row.attachments.map((a) => {
        if (a.type !== "media") return a;
        const thumbnail = thumbnails.get(a.media_id);
        return {
          ...a,
          state: states.get(a.media_id) ?? "pending",
          // ABSENT, NEVER NULL. A spread of `undefined` would still create the key.
          ...(thumbnail ? { thumbnail } : {}),
        };
      }),
    }));
  }

  /** One row, same query, same rule. Named separately so a caller reads as what it is
   * rather than as an array of one. */
  private async withMediaState<T extends { attachments: Attachment[] }>(
    row: T,
  ): Promise<Omit<T, "attachments"> & { attachments: DeliveredAttachment[] }> {
    const [decorated] = await this.withMediaStates([row]);
    return decorated!;
  }

  private async channelsReferencingMedia(mediaId: string): Promise<string[]> {
    // ONE QUERY BODY, TWO CALLERS (chapter 4.14). The verdict seam has no repository to
    // call this on, so the statement moved to a module-level function that takes the
    // scope as an argument. Delegating rather than repeating is what keeps the delivery
    // gate and the fan-out asking the same question of the same predicate.
    return channelsReferencingMediaIn(this.db, this.environmentId, mediaId);
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
      /** Who is reading (FR-002, FR-003).
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
    // MEMBERSHIP FIRST, WHEN A USER IS READING (FR-002, FR-003).
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
      /** (FR-009). A CAST AND NOT A CHECK: `messages.attachments` is a bare
       * `jsonb()` with no `.$type<>()`, so drizzle infers `unknown` and this names it.
       * Postgres enforces no shape on the column. */
      attachments: sql<Attachment[] | null>`${messages.attachments}`,
      // The sender joins the read path in 2.7 (the IOU 2.6 wrote): resume
      // must emit frames identical to live ones, and a reader that gets a
      // different shape depending on which door it came through is a client
      // bug waiting for a reconnect.
      user: users.externalId,
      text: messages.text,
      created_at: messages.createdAt,
      // WHEN IT WAS LAST EDITED, OR NULL (FR-003). Null for every
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
      deleted_at: messages.deletedAt,
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
    // FR-MED-07: the state each media attachment's object is in NOW, added after the
    // page is read and in one query for the whole page (see `withMediaStates`). It is
    // read here rather than stored on the message, so a message sent before a verdict
    // reflects the verdict the next time anybody reads it.
    return this.withMediaStates(
      rows.map((row) => ({
      ...row,
      /** FR-007's `?? []`, IN THE MAP AND NOT IN THE CALLER.
       *
       * A message with no attachments stores NULL and is RETURNED with an empty list, so
       * a reader needs no special case. Putting the conversion in each caller would give
       * the platform as many answers as it has callers — and the revisions chapter shipped a
       * control test that was green before its field existed, because `?? null` cannot
       * tell an absent key from a null one. This is the one place that decides. */
      attachments: row.attachments ?? [],
      created_at: toIso(row.created_at),
      // `null`, NOT `undefined`, and the difference is what a test can see. An absent
      // key and a null one are the same value through `??` — the control test for this
      // field was green before the field existed because its first draft used `??`.
      edited_at: row.edited_at === null ? null : toIso(row.edited_at),
      // CHAPTER 4.19, FR-007. `null`, NOT `undefined`, for the reason the line above
      // states: an absent key and a null one are the same value through `??` and
      // different to a contract. This is the field that lets a client catching up
      // through history tell a removal from a message that never had text, and say
      // when — the `message.deleted` frame and the webhook have carried the instant
      // since 3.23 and this surface did not.
      deleted_at: row.deleted_at === null ? null : toIso(row.deleted_at),
      })),
    );
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

  /** ONE PAGE OF THIS ENVIRONMENT'S EXPIRED MESSAGES — FR-MOD-06's predicate.
   *
   * Called by `sweepRetention` in `../retention/sweep.ts`, once per page per
   * environment with a policy. The convention `CLAUDE.md` sets: a claim about when a
   * symbol runs names the thing that runs it.
   *
   * THE BOUND IS A CONSTANT COMPUTED BY THE CALLER, which is the whole reason this is
   * one query per environment rather than one join across all of them. Written as a
   * join over every environment the age lands in a `Join Filter` — measured, 617
   * buffers with `Rows Removed by Join Filter: 1018`. Per environment with the bound
   * bound it is 73 and the planner reaches `channels_environment_last_activity`.
   * **Neither is a speedup over the other**: 546 of that 617 is the scan of all 33,051
   * environments, which the per-environment form pays too as its first step. What this
   * shape buys is pageability and a predicate the planner can push into an index.
   *
   * KEYSET ON `(channel_id, created_at)`, which is what `messages_channel_created`
   * exists for. Chapter 4.13's sweep read one page with an offset and the head never
   * moved, so an object nobody uploaded to stayed `pending` for ever. And the cursor is
   * a SQL row value rather than an `OR` chain: chapter 4.18 measured that an `OR`
   * cursor lands in a `Filter:` and re-walks every earlier page. */
  async expiredMessageIds(
    olderThan: Date,
    limit: number,
    after?: { channelId: string; createdAt: Date },
  ): Promise<
    {
      id: string;
      channelId: string;
      createdAt: Date;
      attachments: Attachment[] | null;
    }[]
  > {
    return this.db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        createdAt: messages.createdAt,
        // THE FORWARD HALF OF FR-MED-11, AND IT IS FREE. `attachments` is a jsonb
        // column on the row the sweep already has in hand, so collecting the
        // `media_id` values costs no second query. The expensive half is the reverse
        // question — *is this object still referenced?* — which `unreferencedAmong`
        // answers for the whole batch at once.
        //
        // AND IT MUST BE READ BEFORE THE DELETE, which is the one ordering constraint
        // in this pair that is not obvious: after `destroyMessages` the rows are gone
        // and so is every id they named.
        attachments: sql<Attachment[] | null>`${messages.attachments}`,
      })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(channels.environmentId, this.environmentId),
          lt(messages.createdAt, olderThan),
          after
            ? sql`(${messages.channelId}, ${messages.createdAt}) > (${after.channelId}::uuid, ${after.createdAt})`
            : undefined,
        ),
      )
      .orderBy(asc(messages.channelId), asc(messages.createdAt))
      .limit(limit);
  }

  /** DESTROY A PAGE OF EXPIRED MESSAGES, AND THE VERSION ROWS THEY OWN.
   *
   * Called by `sweepRetention` in `../retention/sweep.ts` and by nothing else. This is
   * the one legitimate hard deletion outside FR-MOD-04's compliance endpoint, which
   * ADR-36's first decision licenses by reading the constitution's *compliance path* as
   * admitting a retention sweep.
   *
   * THE `SET LOCAL` IS THE MECHANISM AND THE WORD `LOCAL` IS THE GUARANTEE. Without it
   * the flag outlives this transaction on a pooled connection and every later request
   * can delete version rows — measured. And `SET LOCAL` outside a transaction block is
   * a WARNING, not an error, which leaves the flag unset and every cascade refused in a
   * way that looks exactly like the trigger working. Both failures are silent and they
   * point in opposite directions, so the delete runs inside this explicit transaction
   * and `retention.itest.ts` asserts the flag's VALUE at the moment of the delete.
   *
   * The version rows go by `ON DELETE CASCADE` rather than by a second statement here:
   * a cascade keeps *a version cannot outlive its message* in the schema instead of in
   * a procedure somebody maintains. `0025` records why that needed a trigger exception
   * at all — a cascade issues an ordinary `DELETE` and a row trigger fires on it. */
  /** DESTROY MEDIA OBJECTS AND THE RENDITIONS THAT HANG OFF THEM, returning what the
   * caller needs to finish the job outside the database.
   *
   * Called by `sweepRetention` in `../retention/sweep.ts`, after the messages that
   * referenced them are gone and after `unreferencedAmong` has confirmed no surviving
   * message still names them. Nothing else deletes a `media_objects` row: chapter 4.15
   * established that the rejection path removes bytes and keeps the row on purpose, so
   * before this chapter the table only ever grew.
   *
   * **THE RENDITIONS GO BY CASCADE**, `media_objects_parent_fk`, which chapter 4.15
   * chose precisely so a rendition's reachability is its parent's and no caller has to
   * keep two deletes in step. The keys come back anyway, because the STORE has no
   * foreign keys and the bytes have to be removed one request at a time.
   *
   * RETURNS THE ROWS RATHER THAN A COUNT because the caller owes two more things per
   * object: a `deleteObjectWithRenditions` against the store, and a `deleted` storage
   * event whose `bytesDelta` is negative (FR-013). Neither can be reconstructed from a
   * number. */
  async destroyMediaObjects(ids: readonly string[]): Promise<
    {
      id: string;
      objectKey: string;
      declaredBytes: number;
      mimeType: string;
      renditionKeys: string[];
    }[]
  > {
    if (ids.length === 0) return [];

    const scoped = and(
      inArray(mediaObjects.id, [...ids]),
      // THE TENANCY PREDICATE, AND HERE A MISS IS A LOSS RATHER THAN A LEAK.
      eq(mediaObjects.environmentId, this.environmentId),
      isNull(mediaObjects.parentId),
    );

    const parents = await this.db
      .select({
        id: mediaObjects.id,
        objectKey: mediaObjects.objectKey,
        declaredBytes: mediaObjects.declaredBytes,
        // THE MIME TYPE RATHER THAN THE KIND. The storage event wants a `kind`, and
        // `kindOf` is the one function that maps between them — it lives in `media/`
        // and this file does not reach into a feature directory. The caller converts.
        mimeType: mediaObjects.mimeType,
      })
      .from(mediaObjects)
      .where(scoped);
    if (parents.length === 0) return [];

    const parentIds = parents.map((p) => p.id);
    const renditions = await this.db
      .select({ parentId: mediaObjects.parentId, objectKey: mediaObjects.objectKey })
      .from(mediaObjects)
      .where(inArray(mediaObjects.parentId, parentIds));

    await this.db.delete(mediaObjects).where(scoped);

    return parents.map((p) => ({
      ...p,
      renditionKeys: renditions
        .filter((r) => r.parentId === p.id)
        .map((r) => r.objectKey),
    }));
  }

  /** Whether a media object row is still there. Called by `retention.itest.ts` only —
   * `listMessagesRaw`'s convention, because lint keeps SQL in this directory. */
  async mediaObjectExistsRaw(id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: mediaObjects.id })
      .from(mediaObjects)
      .where(
        and(eq(mediaObjects.id, id), eq(mediaObjects.environmentId, this.environmentId)),
      );
    return rows.length > 0;
  }

  /** How many renditions hang off a parent object. Called by `retention.itest.ts`. */
  async renditionCountRaw(parentId: string): Promise<number> {
    const rows = await this.db
      .select({ id: mediaObjects.id })
      .from(mediaObjects)
      .where(eq(mediaObjects.parentId, parentId));
    return rows.length;
  }

  /** HOW MANY VERSION ROWS A MESSAGE OWNS. Called by `retention.itest.ts` only, which
   * is `listMessagesRaw`'s convention: a test that needs SQL cannot write it, because
   * `eslint.config.mjs` restricts `drizzle-orm` and `pg` to this directory. */
  async versionRowCountRaw(messageId: string): Promise<number> {
    const rows = await this.db
      .select({ id: messageEdits.messageId })
      .from(messageEdits)
      .where(eq(messageEdits.messageId, messageId));
    return rows.length;
  }

  /** Move a message's `created_at` back by whole days, each fixture to its own instant.
   *
   * Called by `retention.itest.ts` only. **Nothing on this lane is thirty days old** —
   * the oldest message is 2026-09-14 and FR-MOD-06's shortest policy is thirty days —
   * so every retention fixture is backdated and the chapter says so rather than
   * implying it measured real traffic. */
  async backdateMessageRaw(messageId: string, days: number): Promise<void> {
    await this.db
      .update(messages)
      .set({ createdAt: sql`now() - make_interval(days => ${days})` })
      .where(eq(messages.id, messageId));
  }

  /** An UPDATE the append-only trigger must refuse, flag or no flag.
   *
   * Called by `retention.itest.ts` only. It exists to be rejected: `TG_OP = 'DELETE'`
   * is part of `0025`'s condition precisely so that expiry destroys rows and never
   * rewrites one, and reading that condition is not testing it. */
  async tamperVersionRowRaw(messageId: string): Promise<void> {
    await this.db
      .update(messageEdits)
      .set({ priorText: "tampered" })
      .where(eq(messageEdits.messageId, messageId));
  }

  /** A DELETE of the children with no flag set, which the trigger must still refuse.
   *
   * Called by `retention.itest.ts` only. The exception `0025` opens is one verb on one
   * table reached one way; this is the same verb reached the other way. */
  async deleteVersionRowsRaw(messageId: string): Promise<void> {
    await this.db.delete(messageEdits).where(eq(messageEdits.messageId, messageId));
  }

  /** Delete the `users` row itself, with nothing cleared first.
   *
   * Called by `erasure.itest.ts` only — `listMessagesRaw`'s convention, because
   * `eslint.config.mjs` keeps `drizzle-orm` inside this directory.
   *
   * IT EXISTS TO BE REFUSED. All five foreign keys to `users` are `NO ACTION`, so a
   * row with any child anywhere is unreachable and the error names the key that
   * stopped it. That refusal is why `eraseUser` traverses children first and the row
   * last: the order is a correctness property rather than a preference, and the only
   * way to show it is to try the row on its own and be told no. The control — the
   * same statement against a user with no children — is what makes the refusal mean
   * the keys rather than a broken call. */
  async deleteUserRowRaw(userId: string): Promise<number> {
    const gone = await this.db
      .delete(users)
      .where(and(eq(users.id, userId), eq(users.environmentId, this.environmentId)))
      .returning({ id: users.id });
    return gone.length;
  }

  async destroyMessages(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL relay.expiring = 'on'`);
      const destroyed = await tx
        .delete(messages)
        .where(
          and(
            inArray(messages.id, ids),
            // THE TENANCY PREDICATE, AND IT IS NOT DECORATION. `ids` arrives from
            // `expiredMessageIds`, which is already scoped — but this is a bulk DELETE,
            // and constitution I's usual failure is a leak where this one is a loss.
            // An id from another tenant reaching this list destroys that tenant's data.
            inArray(
              messages.channelId,
              this.db
                .select({ id: channels.id })
                .from(channels)
                .where(eq(channels.environmentId, this.environmentId)),
            ),
          ),
        )
        .returning({ id: messages.id });
      return destroyed.length;
    });
  }
}

/** SET OR CLEAR AN ENVIRONMENT'S RETENTION POLICY — FR-MOD-06's only write.
 *
 * Called by `EnvironmentsController.patch` and by `retention.itest.ts`. Standalone
 * rather than a `Repository` method because the caller already holds the environment
 * id as the thing it is addressing, not as a scope it is reading within — and the
 * controller resolves tenancy before it gets here.
 *
 * **`null` IS INDEFINITE AND IS NOT A MISSING FIELD.** FR-MOD-06's fourth option is
 * *indefinite*, and the absence of a value is how this schema has spelled that since
 * chapter 2.1. A client clearing a policy sends `null` explicitly; a client omitting
 * the field changes nothing, and the two are different requests all the way down — the
 * route's schema distinguishes them and so does this signature, which is why it takes
 * `number | null` rather than `number | undefined`.
 *
 * The three legal values are enforced by `environments_retention_days_check` rather
 * than here: the clause enumerates them, and a constraint is how an enumeration
 * survives a caller nobody anticipated. */
export async function setRetentionPolicy(
  db: Db,
  environmentId: string,
  retentionDays: number | null,
): Promise<{ id: string; name: string; retentionDays: number | null } | undefined> {
  const [row] = await db
    .update(environments)
    .set({ retentionDays })
    .where(eq(environments.id, environmentId))
    .returning({
      id: environments.id,
      name: environments.kind,
      retentionDays: environments.retentionDays,
    });
  return row;
}
