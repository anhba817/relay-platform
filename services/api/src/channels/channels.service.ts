import { HttpStatus, Injectable, NotFoundException } from "@nestjs/common";

import { protocolError } from "../protocol-error";

import { Repository, type ChannelRow } from "../db/repository";
import { CHANNEL_MEMBER_LIMIT, type AddMembersBody, type CreateChannelBody } from "./channels.schema";

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

export interface MemberResult {
  user_id: string;
  external_id: string;
  status: "added" | "already_a_member";
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
    for (const externalId of body.user_ids) {
      const user = await this.repo.createUser(externalId);
      const outcome = await this.repo.addMember(channelId, user.id);
      if (outcome === "not_found") {
        // The channel was read above and both ids are this environment's, so this
        // is not reachable by a foreign request — it means the channel was deleted
        // between the read and here. Answer as the read would have.
        throw new NotFoundException("channel not found");
      }
      results.push({ user_id: user.id, external_id: externalId, status: outcome });
    }
    return results;
  }
}
