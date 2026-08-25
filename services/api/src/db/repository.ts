import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";

import type { Db } from "./client";
import {
  apiKeys,
  applications,
  channels,
  consumedEvents,
  environments,
  humans,
  members,
  readPositions,
  memberships,
  messages,
  organisations,
  outbox,
  users,
} from "./schema";
import { messageCreatedEvent } from "../outbox/event";
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

/** How far behind the relay is. The single number worth alarming on later, and
 * the one the chapter shows going up while the broker is down. */
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
export class SenderNotPermittedError extends Error {
  constructor(readonly userId: string) {
    super("an application credential may send only as a bot user");
    this.name = "SenderNotPermittedError";
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

export class Repository {
  // Constructor parameter properties — the shorthand chapter 1.4 released
  // for this service when ADR-15 spent erasableSyntaxOnly on decorator
  // metadata. The guarantee still holds in the gateway and every package.
  constructor(
    private readonly db: Db,
    private readonly environmentId: string,
  ) {}

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
  async addMember(
    channelId: string,
    userId: string,
    /** FR-011b. Absent means the column's own default — `member` —
     * which is what keeps every existing caller working unchanged. An entry that
     * names a role is creating a member WITH one rather than changing them into one
     * afterwards, which is what US6's first scenario asks for. */
    role?: string,
  ): Promise<AddMemberOutcome> {
    const inserted = await this.db.execute(
      role === undefined
        ? sql`INSERT INTO members (channel_id, user_id)
          SELECT c.id, u.id FROM channels c, users u
          WHERE c.id = ${channelId} AND c.environment_id = ${this.environmentId}
            AND u.id = ${userId} AND u.environment_id = ${this.environmentId}
          ON CONFLICT (channel_id, user_id) DO NOTHING
          RETURNING channel_id`
        : sql`INSERT INTO members (channel_id, user_id, role)
          SELECT c.id, u.id, ${role} FROM channels c, users u
          WHERE c.id = ${channelId} AND c.environment_id = ${this.environmentId}
            AND u.id = ${userId} AND u.environment_id = ${this.environmentId}
          ON CONFLICT (channel_id, user_id) DO NOTHING
          RETURNING channel_id`,
    );
    if ((inserted.rowCount ?? 0) > 0) return "added";

    const existing = await this.db
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
    const deleted = await this.db
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
      .returning({ userId: members.userId });
    const removed = new Set(deleted.map((r) => r.userId));

    // SCOPED BY environment_id AND NOT BY THE CHANNEL JOIN, because this table
    // carries one. `members` above needs the `EXISTS` over `channels` to stay inside
    // a tenant; `read_positions` was given `environment_id` precisely so the guard
    // could watch it, and the same column makes this predicate direct.
    //
    // EVERY id THE CALLER NAMED, not just the ones a membership was removed for. A
    // user with a read position and no membership is the state this is cleaning up,
    // and refusing to touch it because the membership was already gone would leave
    // exactly the row the delete exists for.
    await this.db
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
      if (!promotable) {
        const current = await this.getUserByExternalId(externalId);
        if (current === null) {
          throw new Error(`user ${externalId} could not be created or read`);
        }
        return { user: current, status: "kind_conflict" };
      }
    }

    if (before !== undefined) {
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
    return { user: after, status: before?.deletedAt != null ? "revived" : "updated" };
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
  async banUser(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ bannedAt: new Date() })
      .where(
        and(
          eq(users.id, userId),
          eq(users.environmentId, this.environmentId),
          isNull(users.bannedAt),
        ),
      );
  }

  async unbanUser(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ bannedAt: null })
      .where(
        and(eq(users.id, userId), eq(users.environmentId, this.environmentId)),
      );
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
      return true;
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
    return this.db.transaction(async (tx) => {

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
      // `MessagesController` declared no `@Accepts` until the sender chapter — so the
      // guard fell back to `EITHER` and a user token was accepted there. A check gated on a parameter
      // no caller fills in is a check that never fires, and this one did not, on
      // the only send path a customer's own client uses.
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

      // THE SENDER'S KIND, LAST OF THE FIVE (FR-007, T032).
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
          created_at: createdAt,
        },
      });
      await tx.insert(outbox).values({
        subject: event.subject,
        payload: event.payload,
      });

      return {
        id,
        channel_id: channel.id,
        seq,
        text,
        created_at: createdAt,
      };
    });
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
