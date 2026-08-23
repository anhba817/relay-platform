import { HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";

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
      throw new HttpException(
        {
          code: "channel_member_limit_exceeded",
          message:
            `this channel holds ${existing} of ${CHANNEL_MEMBER_LIMIT} members; ` +
            `adding ${body.user_ids.length} would exceed the limit`,
        },
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
