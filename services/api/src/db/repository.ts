import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, lt, sql, type SQL } from "drizzle-orm";

import type { Db } from "./client";
import { channels, members, messages, users } from "./schema";

// The repository layer — the ONE place data access lives (ADR-04's single
// writer, constitution I). Two surfaces with a bright line between them:
//
//   createEnvironment — the ADMIN surface. It creates tenants, so it is the
//   only operation here that is not tenant-scoped. It also inserts a stub
//   application row to satisfy environments' NOT NULL foreign key (recorded
//   decision: the real application lifecycle belongs to Part 3).
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
  const applicationId = randomUUID();
  const environmentId = randomUUID();
  // The admin surface writes through the same Db handle but carries no
  // tenant scope — it is the operation that MINTS the scope.
  await db.execute(
    sql`INSERT INTO applications (id, name) VALUES (${applicationId}, ${name})`,
  );
  await db.execute(
    sql`INSERT INTO environments (id, application_id, kind, signing_secret)
        VALUES (${environmentId}, ${applicationId}, ${kind}, ${randomUUID()})`,
  );
  return { id: environmentId, kind };
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
      text,
      metadata,
      idempotencyKey,
    }: {
      userId?: string;
      text: string;
      metadata?: unknown;
      idempotencyKey?: string;
    },
  ): Promise<MessageRow> {
    return this.db.transaction(async (tx) => {
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

      return {
        id,
        channel_id: channel.id,
        seq,
        text,
        created_at: toIso(inserted[0]!.createdAt),
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
