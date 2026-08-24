import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";

import { protocolError } from "../protocol-error";

import { Repository, type ChannelRow } from "../db/repository";
import {
  CHANNEL_MEMBER_LIMIT,
  normaliseEntry,
  type AddMembersBody,
  type ChannelRole,
  type CreateChannelBody,
  type RemoveMembersBody,
} from "./channels.schema";

// THE TWO ENDPOINTS PART 3 NEEDED AND NOBODY HAD BUILT (FR-016 to FR-019).
//
// `packages/e2e/src/harness.ts` has said since chapter 2.8 that creating a channel
// and adding a member is "Part 3's tenancy work". Part 3 ends at 3.12, and this
// chapter's exit criterion is that an outsider integrates on public documentation
// alone — which was unreachable for a reason that had nothing to do with
// documentation: there was no public way to make a channel to send a message to.
//
// This is the minimum that unblocks it. The rest of FR-CHN and all of FR-USR go to
// chapter 3.13.

export interface CreatedChannel {
  channel: ChannelRow;
  /** 201 or 200 at the controller. FR-CHN-02 says return the existing channel; it
   * does not say return the same status, and the difference is something an
   * integrating developer can act on — chapter 2.3 drew the same line for a
   * duplicate send. */
  created: boolean;
}

export interface MemberRemoval {
  external_id: string;
  /** `removed` if a membership row went away, `not_a_member` otherwise — including
   * when the external id belongs to no user this tenant knows. */
  result: "removed" | "not_a_member";
}

export interface MemberResult {
  user_id: string;
  external_id: string;
  status: "added" | "already_a_member";
  /** Chapter 3.15. What role the member holds AFTER the call — read back, not
   * echoed, so an `already_a_member` reports the role they already had rather than
   * the one the request asked for. Adding is not changing. */
  role: string;
}

@Injectable()
export class ChannelsService {
  constructor(private readonly repo: Repository) {}

  async create(body: CreateChannelBody): Promise<CreatedChannel> {
    const result = await this.repo.createChannel(
      body.external_id,
      body.type,
      body.name,
      body.metadata,
    );
    const { created, ...channel } = result;
    return { channel, created };
  }

  /** One channel by id, with the caller's membership (chapter 3.15, FR-003a, FR-003).
   *
   * THE ANSWER FOR A PRIVATE CHANNEL THE CALLER CANNOT SEE IS THE NOT-FOUND
   * ENVELOPE, and it has to be byte-identical to the answer for a channel that does
   * not exist — SC-002, over the same oracle chapter 3.12 built for cross-tenant
   * pairs. A `403` naming the membership would announce that the channel exists,
   * which is what FR-003 forbids. So both paths raise the same exception with the
   * same constant message, and the message names no id: echoing it back would make
   * the two answers differ, and different is itself a disclosure.
   *
   * `userId` ABSENT MEANS THE TENANT IS ASKING. An application credential acts for
   * the customer, carries no user, and sees private channels (FR-005) — so it gets
   * the row and a membership of `null`, because the tenant is not a member of
   * anything. A user token gets `true` or `false`.
   *
   * FR-004's answer for the other type: a `public` channel is readable by any
   * authenticated user of the tenant, member or not. The column decides something
   * only because the two types differ. */
  async read(
    channelId: string,
    userId?: string,
  ): Promise<{
    channel: ChannelRow & { archived_at: Date | null };
    isMember: boolean | null;
  }> {
    const channel = await this.repo.getChannelById(channelId);
    if (!channel) throw this.notFound();

    const isMember =
      userId === undefined ? null : await this.repo.isMember(channelId, userId);

    if (channel.type === "private" && isMember === false) throw this.notFound();

    return { channel, isMember };
  }

  /** Remove members by EXTERNAL id, reporting each (chapter 3.15, FR-006, FR-007).
   *
   * THE CHANNEL IS READ SCOPED FIRST, the same ordering `addMembers` states below
   * and for the same reason: a foreign channel id and one that exists nowhere both
   * fail that read, so both answer alike and neither reveals the other tenant's
   * channel. A private channel the caller cannot see answers the same way — this is
   * a tenant credential's route, and the tenant sees its own private channels
   * (FR-005), so in practice only absence and foreignness refuse here.
   *
   * A USER THAT DOES NOT EXIST REPORTS `not_a_member`, per entry, rather than
   * failing the request. It is not a member — that is simply true — and answering
   * anything else would make this route a membership oracle for user ids: a caller
   * could sweep external ids and learn which ones this tenant knows. One bad entry
   * must not refuse the other ninety-nine.
   */
  async removeMembers(
    channelId: string,
    body: RemoveMembersBody,
  ): Promise<MemberRemoval[]> {
    if (!(await this.repo.channelExists(channelId))) throw this.notFound();

    // External ids to row ids, and the ones with no row are already answered: no
    // user, no membership. `getUserByExternalId` is scoped, so an id belonging to
    // another tenant resolves to nothing here — which is the same answer as an id
    // belonging to nobody, and deliberately so.
    const resolved = new Map<string, string | null>();
    for (const externalId of body.user_ids) {
      const user = await this.repo.getUserByExternalId(externalId);
      resolved.set(externalId, user?.id ?? null);
    }

    const ids = [...resolved.values()].filter((id): id is string => id !== null);
    const outcomes = await this.repo.removeMembers(channelId, ids);

    return body.user_ids.map((externalId) => {
      const id = resolved.get(externalId) ?? null;
      return {
        external_id: externalId,
        result: id === null ? "not_a_member" : (outcomes.get(id) ?? "not_a_member"),
      };
    });
  }

  /** Archive and unarchive (chapter 3.15, FR-020, FR-020a).
   *
   * Both answer 200 whether or not the state changed. "Already archived" is not an
   * error: the customer asked for the channel to be archived and it is. What DOES
   * refuse is a channel that is not there — the same not-found every other route
   * here gives, so absence and foreignness stay one answer.
   */
  async setArchived(channelId: string, archived: boolean): Promise<{ archived: boolean }> {
    const found = archived
      ? await this.repo.archiveChannel(channelId)
      : await this.repo.unarchiveChannel(channelId);
    if (!found) throw this.notFound();
    return { archived };
  }

  /** Set one member's role by external id (chapter 3.15, FR-011).
   *
   * THE CHANNEL FIRST, then the user, then the membership — each refusing with the
   * same not-found so the three cases are one answer from outside. A caller who can
   * tell "no such channel" from "no such user" from "not a member" has a probe.
   */
  async setMemberRole(
    channelId: string,
    userExternalId: string,
    role: ChannelRole,
  ): Promise<{ external_id: string; role: ChannelRole }> {
    if (!(await this.repo.channelExists(channelId))) throw this.notFound();
    const user = await this.repo.getUserByExternalId(userExternalId);
    if (!user) throw this.notFound();
    const outcome = await this.repo.setMemberRole(channelId, user.id, role);
    if (outcome === "not_a_member") throw this.notFound();
    return { external_id: userExternalId, role };
  }

  /** A user joining a channel themselves (chapter 3.15, FR-CHN-03).
   *
   * FR-CHN-03's exact words are that any authenticated user of the tenant "may read
   * and join" a public channel, and JOIN is the hard half: reading needs no new
   * operation, joining is a user acting on their own behalf rather than the tenant
   * adding somebody. `POST …/members` is the tenant's route; this is the user's.
   *
   * A PRIVATE CHANNEL ANSWERS AS IF ABSENT. Not "you may not join" — that would
   * announce it exists, and joining is one of the verbs SC-001 covers.
   *
   * THE CEILING IS READ, NOT REIMPLEMENTED. Chapter 3.13 counts members from
   * storage and refuses at 1,000 with `channel_member_limit_exceeded`; a second
   * count with its own limit here would be a second answer to one question. */
  async join(channelId: string, userId: string): Promise<"joined" | "already_a_member"> {
    const channel = await this.repo.getChannelById(channelId);
    if (!channel) throw this.notFound();
    if (channel.type === "private") throw this.notFound();

    if (await this.repo.isMember(channelId, userId)) return "already_a_member";

    const existing = await this.repo.countMembers(channelId);
    if (existing + 1 > CHANNEL_MEMBER_LIMIT) {
      throw protocolError(
        "channel_member_limit_exceeded",
        `this channel holds ${existing} of ${CHANNEL_MEMBER_LIMIT} members; ` +
          `joining would exceed the limit`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const outcome = await this.repo.addMember(channelId, userId);
    // `not_found` here means the channel went away between two statements of one
    // call, which nothing in the api can do — it is the same unconstructable state
    // `createChannel` and `createUser` throw for.
    if (outcome === "not_found") throw this.notFound();
    return outcome === "added" ? "joined" : "already_a_member";
  }

  /** The one refusal shape for "you cannot see this", used by every read here.
   *
   * A CONSTANT MESSAGE, for the reason `addMembers` gives below: a message carrying
   * the id makes the foreign-id answer differ from the absent-id answer. */
  private notFound(): Error {
    return new NotFoundException("channel not found");
  }

  /** Members by EXTERNAL id, and a user is created on first membership (FR-CHN-04).
   *
   * THE CHANNEL IS READ SCOPED FIRST, and that ordering is the isolation property
   * rather than a convenience. A foreign channel id and one that exists nowhere both
   * fail this read, so both answer with the same 404 and neither reveals that the
   * other tenant's channel is there. If the ceiling or the user creation happened
   * first, a foreign id would spend work — and could answer differently — before
   * anyone checked whose channel it was. */
  async addMembers(channelId: string, body: AddMembersBody): Promise<MemberResult[]> {
    if (!(await this.repo.channelExists(channelId))) {
      // A CONSTANT message. Echoing the id back would make the foreign-id answer
      // differ from the absent-id answer, and different is itself a disclosure
      // (FR-TEN-05).
      throw new NotFoundException("channel not found");
    }

    // FR-CHN-07's ceiling, counted from storage rather than trusted from the
    // request. Checked BEFORE any user is created: a refused call must not leave
    // rows behind, and creating users for a request about to be refused would do
    // exactly that.
    const existing = await this.repo.countMembers(channelId);
    if (existing + body.user_ids.length > CHANNEL_MEMBER_LIMIT) {
      throw protocolError(
        "channel_member_limit_exceeded",
        `this channel holds ${existing} of ${CHANNEL_MEMBER_LIMIT} members; ` +
          `adding ${body.user_ids.length} would exceed the limit`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const results: MemberResult[] = [];
    for (const entry of body.user_ids) {
      // An entry is a bare external id or an id with a role (FR-011b). Normalised
      // once here so nothing below has to ask which form arrived.
      const { user: externalId, role } = normaliseEntry(entry);
      const user = await this.repo.createUser(externalId);
      const outcome = await this.repo.addMember(
        channelId,
        user.id,
        ...(role === undefined ? [] : ([role] as const)),
      );
      if (outcome === "not_found") {
        // The channel was read above and both ids are this environment's, so this
        // is not reachable by a foreign request — it means the channel was deleted
        // between the read and here. Answer as the read would have.
        throw new NotFoundException("channel not found");
      }
      results.push({
        user_id: user.id,
        external_id: externalId,
        status: outcome,
        // The role the member ends up with, read back rather than echoed: on an
        // `already_a_member` the request's role is NOT applied, because adding is
        // not changing. `PATCH` is the route that changes one.
        role: (await this.repo.memberRole(channelId, user.id)) ?? "member",
      });
    }
    return results;
  }
}
