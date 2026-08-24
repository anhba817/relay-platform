import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, lt, sql, type SQL } from "drizzle-orm";

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
      return { id, external_id: externalId, display_name: displayName ?? null };
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
  async addMember(channelId: string, userId: string): Promise<AddMemberOutcome> {
    const inserted = await this.db.execute(
      sql`INSERT INTO members (channel_id, user_id)
          SELECT c.id, u.id FROM channels c, users u
          WHERE c.id = ${channelId} AND c.environment_id = ${this.environmentId}
            AND u.id = ${userId} AND u.environment_id = ${this.environmentId}
          ON CONFLICT (channel_id, user_id) DO NOTHING`,
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
      /** The sender as a CONSUMER will see them. Threaded from the
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
      const [channel] = await tx
        .select({
          id: channels.id,
          lastSequence: channels.lastSequence,
          // `channels.type` has been a `"public" | "private"` column
          // with a CHECK since chapter 2.1 and nothing decided on it until now — it
          // was returned by the create route and consulted by nothing.
          type: channels.type,
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
      if (channel.type === "private" && userId !== undefined) {
        const [membership] = await tx
          .select({ userId: members.userId })
          .from(members)
          .where(and(eq(members.channelId, channelId), eq(members.userId, userId)))
          .limit(1);
        if (!membership) throw new ChannelNotFoundError(channelId);
      }

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
