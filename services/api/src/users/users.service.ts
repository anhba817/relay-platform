import { HttpStatus, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { Logger } from "@relay/service-kit";

import { protocolError } from "../protocol-error";
import { Repository, type UserRow } from "../db/repository";
import { LOGGER } from "../logger";
import { deleteObjectWithRenditions, storeConfig } from "../media/store";
import { kindOf } from "../media/kinds";
import { publishStorageDelta } from "../metering/storage-event";
import { ANALYTICS_PUBLISHER } from "../webhooks/analytics";
import type { Publisher } from "../outbox/publisher";
import { eraseFromAnalyticalStore, type StoreResult } from "./erasure";
import {
  encodeCursor,
  type ListingQuery,
  type UpsertUsersBody,
  type UserProfileBody,
} from "./users.schema";

/** The user surface (FR-013 and the clauses after it).
 *
 * EVERY ROUTE HERE NAMES ITS USER IN THE PATH, and the credential is the tenant's.
 * So "the caller" on these routes is the application, never the user named — a
 * distinction four documents got wrong for twelve analysis passes, because FR-015's
 * "a channel the caller is not a member of MUST NOT appear in their listing" is
 * vacuous when the caller is an application key: a key is a member of nothing and an
 * empty list satisfied it. The requirement is about the user the PATH names. */
@Injectable()
export class UsersService {
  constructor(
    private readonly repo: Repository,
    @Inject(ANALYTICS_PUBLISHER) private readonly analytics: Publisher,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** A deleted user is a 404 on every route that names them (FR-017).
   *
   * The row survives deletion — a message keeps its author, and `toFrame` drops a
   * senderless row, so "authored by a deleted user" and "authored by nobody" are
   * different states and only one of them is the clause. The marker is what makes the
   * row invisible to the API without making the message anonymous. */
  private async requireUser(externalId: string): Promise<UserRow> {
    const user = await this.repo.getUserByExternalId(externalId);
    if (!user || user.deleted_at !== null) {
      throw new NotFoundException("user not found");
    }
    return user;
  }

  /** The profile as the API shapes it (FR-023).
   *
   * `deleted_at` IS NOT ON THE WIRE. It is read on every route that names a user and it
   * decides a 404; a client never sees a deleted user at all, so returning the marker
   * would be returning a field whose only possible value is null. */
  private static profile(user: UserRow): {
    external_id: string;
    display_name: string | null;
    avatar_url: string | null;
    metadata: Record<string, unknown>;
    kind: "person" | "bot";
    description: string | null;
  } {
    return {
      external_id: user.external_id,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      metadata: user.metadata,
      // `kind` ON EVERY USER, AND THAT IS FR-003 BEING SATISFIED RATHER THAN
      // DOCUMENTED. A client that had to infer personhood from a null
      // description would be inferring it from an absence, and the clause asks for a
      // stored property. `description` is null for a person because the schema refuses
      // to give one, not because nobody has set it yet.
      kind: user.kind,
      description: user.description,
    };
  }

  async readProfile(externalId: string): Promise<ReturnType<typeof UsersService.profile>> {
    return UsersService.profile(await this.requireUser(externalId));
  }

  async updateProfile(
    externalId: string,
    patch: UserProfileBody,
  ): Promise<ReturnType<typeof UsersService.profile>> {
    const user = await this.requireUser(externalId);
    const updated = await this.repo.updateUserProfile(user.id, patch);
    // `null` here means the row went away between the two statements — a deletion racing
    // a patch. 404 is the same answer the read gives, which is the answer that does not
    // depend on which of the two won.
    if (updated === null) throw new NotFoundException("user not found");
    return UsersService.profile(updated);
  }

  async listChannels(
    externalId: string,
    query: ListingQuery,
  ): Promise<{
    data: Array<Record<string, unknown>>;
    next_cursor: string | null;
  }> {
    const user = await this.requireUser(externalId);
    const { rows, nextCursor } = await this.repo.listChannelsForUser(user.id, {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { after: query.cursor }),
    });
    return {
      data: rows.map((r) => ({
        // BOTH IDS, the shape `POST /v1/channels` already returns. `contracts/listing.md`
        // showed `"id": "c_support"` — an external id under the name `id` — which would
        // have made `id` mean the uuid on one route and the customer's own string on
        // another, in one API. The contract is corrected; the create route's shape wins
        // because it shipped.
        id: r.id,
        external_id: r.external_id,
        type: r.type,
        name: r.name,
        role: r.role,
        archived_at: r.archived_at,
        unread: r.unread,
        last_activity_at: r.last_activity_at,
        last_message: r.last_message,
      })),
      next_cursor:
        nextCursor === null
          ? null
          : encodeCursor(nextCursor.activityAt.toISOString(), nextCursor.id),
    };
  }

  /** Record a read position for the user the path names (FR-017, FR-018).
   *
   * THE MEMBERSHIP THIS REFUSAL TALKS ABOUT IS THE PATH'S USER, NOT THE CALLER. Under an
   * application credential the caller has no membership at all — it is the tenant — so
   * "the caller is not a member" is a sentence about nothing on this route. The
   * authorization table's member and non-member columns said nothing for this row until
   * an analysis pass noticed that, and the same mistake sat in five other places.
   *
   * AND THIS IS `not_a_member`'s ONLY EMITTER IN THE WHOLE FEATURE. A read position is
   * per-member state keyed by channel and user, and removal deletes the row with the
   * membership, so refusing a non-member here is the rule the rest of the table keeps.
   * Everywhere else a private channel answers the not-found envelope instead, because a
   * 403 would announce that the channel exists.
   *
   * SO THE ORDER MATTERS: visibility first, then membership. A private channel the user
   * is not in answers 404 — indistinguishable from a channel that does not exist. A
   * PUBLIC channel they are not in answers 403 `not_a_member`, which reveals only that a
   * public channel exists, and a public channel is readable by any user of the tenant
   * anyway. */
  async setReadPosition(
    externalId: string,
    channelId: string,
    sequence: number,
  ): Promise<{ sequence: number }> {
    const user = await this.requireUser(externalId);

    // Visibility for THE PATH'S USER, which is what makes the two refusals different.
    if (!(await this.repo.channelVisibleTo(channelId, user.id))) {
      throw new NotFoundException("channel not found");
    }
    if (!(await this.repo.isMember(channelId, user.id))) {
      throw protocolError(
        "not_a_member",
        "the user is not a member of this channel",
        HttpStatus.FORBIDDEN,
      );
    }

    const written = await this.repo.setReadPosition(channelId, user.id, sequence);
    if (written === null) {
      throw protocolError(
        "invalid_request",
        "sequence is past the channel's last message",
        HttpStatus.BAD_REQUEST,
        "sequence",
      );
    }
    return { sequence: written.sequence };
  }

  /** Up to 100 users in one call, reported per entry (FR-025, FR-026).
   *
   * SEQUENTIAL AND NOT A SINGLE MULTI-ROW STATEMENT. Each entry is its own upsert because
   * each carries its own partial profile: a bulk `INSERT ... ON CONFLICT DO UPDATE` has one
   * `SET` clause for every row, so "leave display_name alone for entry 3 and set it for
   * entry 7" cannot be expressed. 100 round trips inside one request is the cost of
   * FR-026's per-entry semantics, and the bound is what keeps it bounded.
   *
   * NO TRANSACTION AROUND THE BATCH, deliberately. The result array reports per entry, so a
   * caller learns exactly which entries landed; wrapping the batch would turn one bad entry
   * into a hundred silent non-writes and the array would be a lie. Validation already
   * rejected the whole body before any write, so what remains here are failures the
   * database raises, which per-entry reporting is the right shape for.
   */
  async upsertUsers(body: UpsertUsersBody): Promise<{
    data: Array<{
      external_id: string;
      /** A FOURTH STATUS, IN A 200 (FR-002a). `kind_conflict` says the
       * entry asked to change what kind of thing a user is and the change was refused
       * — a promotion whose row has already sent a message, or any demotion.
       *
       * NOT A 400, and the reason is the shape of this route rather than politeness.
       * Zod cannot see the stored row, so this refusal is only knowable mid-batch; a
       * status code would fail all hundred entries because of entry 7, which is what
       * this per-entry array exists to prevent. The boundary keeps the refusals a
       * customer can fix by re-reading their own request — a bot with no description,
       * a person with one — and those still fail the whole body. */
      status: "created" | "updated" | "revived" | "kind_conflict";
      display_name: string | null;
      avatar_url: string | null;
      metadata: Record<string, unknown>;
      kind: "person" | "bot";
      description: string | null;
    }>;
  }> {
    const data = [];
    for (const entry of body.users) {
      const { external_id, ...profile } = entry;
      const { user, status } = await this.repo.upsertUser(external_id, profile);
      data.push({
        external_id: user.external_id,
        status,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        metadata: user.metadata,
        kind: user.kind,
        description: user.description,
      });
    }
    return { data };
  }

  /** Delete a user (FR-027 to FR-029).
   *
   * IDEMPOTENT AT 200 AND 404 FOR A USER WHO NEVER EXISTED. `requireUser` cannot be used
   * here — it 404s a user who is already deleted, and deleting twice is the ordinary
   * outcome of a customer's retry after a timeout. So the row is read without the
   * liveness filter, and only "no row at all" is a 404. */
  async deleteUser(externalId: string): Promise<{ external_id: string; deleted: true }> {
    const user = await this.repo.getUserByExternalId(externalId);
    if (!user) throw new NotFoundException("user not found");
    await this.repo.deleteUser(user.id, externalId);
    return { external_id: externalId, deleted: true };
  }

  /** Erase an end user from every store that can remove them (FR-MOD-04).
   *
   * NOT `deleteUser`, which is the method directly above and keeps the row, the
   * messages and the billing rows on purpose. The two verbs sit next to each other
   * here for the same reason their routes do: `contracts/erasure.md` argues that two
   * operations differing only in what they preserve must not differ only in a flag,
   * and side by side they are harder to confuse than in two files.
   *
   * A SECOND ERASURE IS A 404 AND THAT INVERTS THE OBVIOUS ANSWER. The traversal
   * replaces `external_id`, so after the first call no user has the one in the path.
   * `deleteUser` above goes to some trouble to answer 200 twice; this cannot, and a
   * hash kept on the tombstone to make it possible is refused — `u-4821` and an email
   * address are both brute-forceable, so a hash is the identity wearing a disguise.
   * **The operator's proof is the audit entry**, which is append-only by design. */
  async eraseUser(externalId: string): Promise<{
    user_external_id: string;
    requested_at: string;
    completed_at: string;
    stores: StoreResult[];
  }> {
    const requestedAt = new Date();
    const user = await this.repo.getUserByExternalId(externalId);
    if (!user) throw new NotFoundException("user not found");

    const erased = await this.repo.eraseUser(user.id, externalId);

    // THE BYTES AND THE DELTAS, OUTSIDE THE TRANSACTION AND ONE REQUEST PER OBJECT.
    // The store has no foreign keys and nothing cascades there, and a publish inside a
    // transaction that rolled back would emit a delta for an object that still exists
    // — `storage-event.ts` makes both arguments. The operational quota recomputes from
    // the rows and the analytical meter does not, which is what makes a skipped delta
    // a permanent overcount rather than a blip.
    for (const row of erased.media) {
      await deleteObjectWithRenditions(
        storeConfig(),
        row.objectKey,
        row.renditionKeys,
      );
      void publishStorageDelta(this.analytics, this.logger, {
        environmentId: this.repo.environment,
        mediaId: row.id,
        cause: "deleted",
        kind: kindOf(row.mimeType) ?? "image",
        // NEGATIVE, AND CARRIED RATHER THAN DERIVED FROM `cause`: a reader that infers
        // the sign puts the rule in a second place.
        bytesDelta: -row.declaredBytes,
        occurredAt: new Date(),
      });
    }

    // THE ANALYTICAL HALF RUNS AFTER THE OPERATIONAL ONE HAS COMMITTED, and its
    // failure is a receipt line rather than an exception. Constitution III: a
    // ClickHouse outage must not roll back an erasure that has already destroyed a
    // person's profile, their external id and their uploads.
    const analytical = await eraseFromAnalyticalStore(
      this.repo.environment,
      externalId,
    );

    return {
      user_external_id: externalId,
      requested_at: requestedAt.toISOString(),
      completed_at: new Date().toISOString(),
      stores: [
        { store: "profile", outcome: "erased", rows: erased.profile,
          note: "display_name, avatar_url, metadata AND external_id" },
        { store: "memberships", outcome: "erased", rows: erased.memberships },
        { store: "read_positions", outcome: "erased", rows: erased.readPositions },
        // THE NOTE IS THE POINT, NOT THE COUNT. `media_objects.user_id` is nullable
        // and 73.6% of objects on this platform record no uploader — 11,173 of
        // 15,189 — so an erasure that takes the attributed ones is correct AND
        // incomplete. The receipt is where that gets said; a comment in the source
        // would be true and unread by the person who needs it.
        { store: "media_objects", outcome: "erased", rows: erased.media.length,
          note: "attributed uploads only; 73.6% of objects platform-wide record no uploader" },
        // NO CLAUSE IDS IN A NOTE, AND IT IS NOT A STYLE RULE. This body is read by a
        // compliance officer at a CUSTOMER, who has no access to this platform's
        // specification — `FR-028` in a receipt is a string they cannot resolve by
        // any means available to them. The reason goes in words or it does not go.
        //
        // (And the two ids the first draft used were feature-local to the chapter
        // that built `deleteUser`, so they do not resolve inside this repository
        // either: there is no FR-028 in `docs/04-srs.md`. The messages clause is
        // FR-USR-05; the billing one is an argument in `deleteUser`'s own comment
        // and no clause at all.)
        { store: "messages", outcome: "retained_anonymous",
          rows: erased.messagesRetained,
          note: "kept: a channel's history must not lose one participant's half of every conversation. The author is erased and the text is not" },
        { store: "usage_active_users", outcome: "retained_anonymous",
          rows: erased.activeUserRowsRetained,
          note: "kept: usage already invoiced. The rows count a user per period and name nobody once the profile is erased" },
        ...analytical,
        { store: "audit_log", outcome: "cannot_erase",
          note: "target_id holds the external id and the log is append-only (ADR-35)" },
      ],
    };
  }

  /** Ban and unban, tenant-wide (FR-031, FR-032).
   *
   * BOTH IDEMPOTENT AND BOTH 200. Banning a banned user and unbanning an unbanned one
   * are the ordinary outcomes of a retry, and the caller's intent is satisfied either
   * way. A 409 here would make a customer's reconciliation loop — "ensure these users
   * are banned" — have to distinguish success from success.
   *
   * A DELETED USER CANNOT BE BANNED, because `requireUser` 404s them. They already
   * cannot connect: the session route resolves the user and a deleted row has no
   * channels, and every route naming them answers 404. Banning one would be a state with
   * no observable difference.
   */
  async setBanned(
    externalId: string,
    banned: boolean,
  ): Promise<{ external_id: string; banned: boolean; revoked: string[] }> {
    const user = await this.requireUser(externalId);
    // `revoked` IS THE CHANGE, and the route's body does not carry it. `banUser`
    // returns the channels the ban actually revoked and an empty array when nothing
    // changed — `isNull(users.bannedAt)` makes a re-ban touch no row — so the
    // controller publishes on a non-empty list and nothing on a repeat (FR-005).
    //
    // ONE CASE READS AS "NO CHANGE" AND IS NOT: banning a user who belongs to no
    // channel returns `[]` too. Nothing is lost by the silence — a connection with no
    // channels receives nothing whether or not it is told — and distinguishing the
    // two would mean widening the repository's return for a publish with no audience.
    const revoked = banned ? await this.repo.banUser(user.id) : [];
    if (!banned) await this.repo.unbanUser(user.id);
    return { external_id: externalId, banned, revoked };
  }
}
