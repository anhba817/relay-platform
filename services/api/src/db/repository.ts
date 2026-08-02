import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

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

  /** The write path (chapter 2.2): sequence assignment under the channel
   * row lock (ADR-03). The transaction IS the ordering guarantee: the
   * lock serialises assignment per channel, and the ack that matters
   * happens only after commit (FR-MSG-05).
   */
  async sendMessage(
    channelId: string,
    {
      userId,
      text,
      metadata,
    }: { userId?: string; text: string; metadata?: unknown },
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
      await tx
        .update(channels)
        .set({ lastSequence: seq })
        .where(eq(channels.id, channel.id));
      await tx.insert(messages).values({
        id,
        channelId: channel.id,
        sequence: seq,
        userId: userId ?? null,
        text,
        metadata: metadata ?? {},
      });
      return {
        id,
        channel_id: channel.id,
        seq,
        text,
        created_at: new Date().toISOString(),
      };
    });
  }
}
