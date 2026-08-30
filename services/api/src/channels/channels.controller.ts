import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";

import { Inject } from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { RequestWithPrincipal } from "../auth/principal";
import { Repository } from "../db/repository";
import {
  MEMBERSHIP_PUBLISHER,
  type MembershipPublisher,
} from "../membership/publisher";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";
import { ChannelsService } from "./channels.service";
import {
  addMembersBodySchema,
  createChannelBodySchema,
  removeMembersBodySchema,
  setMemberRoleBodySchema,
} from "./channels.schema";
import type {
  AddMembersBody,
  CreateChannelBody,
  RemoveMembersBody,
  SetMemberRoleBody,
} from "./channels.schema";

// THE PUBLIC CHANNEL SURFACE (FR-016, FR-019, data-model.md §7).
//
// `@Accepts("application")` and not both classes: creating a channel and deciding
// who is in it are server-side acts. An end-user token is minted for one person
// (FR-AUT-10), and a person adding themselves to a channel is a product decision
// this chapter is not making — chapter 3.15 owns the user-facing surface.
/** The one thing this controller needs from the response object.
 *
 * Declared rather than imported, which is chapter 3.4's decision in
 * `signup.controller.ts` and its reason still holds: `@Res()` normally means
 * importing express's `Response` type, express 5 ships no types, and adding
 * `@types/express` for one method signature would move the api's dependency list
 * for nothing. */
interface HttpResponse {
  status(code: number): unknown;
}

@Controller("v1/channels")
@UseGuards(CredentialGuard)
@Accepts("application")
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    // For resolving a user token's subject to a row id. The service takes an id
    // because the repository's membership lookup is keyed on it.
    private readonly repo: Repository,
    // THE CONTROLLER, NOT THE SERVICE (chapter 3.20, FR-004). `ChannelsService`'s
    // constructor takes only the `Repository`, so it holds no request id and no
    // logger — and FR-015's failure line needs both. `messages.controller.ts` puts
    // the fan-out publish at this same layer for this same reason.
    @Inject(MEMBERSHIP_PUBLISHER)
    private readonly membership: MembershipPublisher,
  ) {}

  /** 201 on creation, 200 on the idempotent repeat (FR-017, FR-CHN-02).
   *
   * `@Res({ passthrough: true })` rather than a fixed `@HttpCode`, because the
   * status is the answer here: FR-CHN-02 says return the existing channel, and an
   * integrating developer who cannot tell "I made this" from "this was already
   * here" has to go and read the body to find out. Chapter 2.3 drew the same line
   * for a duplicate send. */
  @Post()
  async create(
    @Body(new ZodValidationPipe(createChannelBodySchema)) body: CreateChannelBody,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const { channel, created } = await this.channels.create(body);
    res.status(created ? 201 : 200);
    return {
      id: channel.id,
      external_id: channel.external_id,
      type: channel.type,
      name: channel.name,
      metadata: channel.metadata,
    };
  }

  /** One channel by id (chapter 3.15, FR-003a).
   *
   * THIS ROUTE DID NOT EXIST, and three artifacts assumed it did: SC-001 named
   * "read by id" as one of four verbs a non-member must not reach, FR-003 said
   * "every read", and `contracts/membership.md` had a row for it. A customer could
   * create a channel and never read its four fields back.
   *
   * `@Accepts("application", "user")` AT THE METHOD, overriding the class's
   * `"application"`. `credential.guard.ts` resolves
   * `getAllAndOverride([handler, class])`, so a method-level decorator wins — the
   * pattern `dev-token.controller.ts` already uses. Both classes belong here: the
   * tenant reads any of its channels (FR-005), and a user reads the ones they may
   * see, which is what makes `channels.type` decide something.
   */
  @Get(":channelId")
  @Accepts("application", "user")
  async read(
    @Param("channelId") channelId: string,
    @Req() req: RequestWithPrincipal,
  ) {
    const actingExternalId =
      req.principal?.kind === "user" ? req.principal.userExternalId : undefined;
    let userId: string | undefined;
    if (actingExternalId !== undefined) {
      const user = await this.repo.getUserByExternalId(actingExternalId);
      // A user token for an identifier with no row is a member of nothing. Refusing
      // rather than reading as the tenant is the same choice the send path makes,
      // and FR-039a removes the case by creating the row when the token is minted.
      if (!user) throw new BadRequestException("unknown user");
      userId = user.id;
    }
    const { channel, isMember } = await this.channels.read(channelId, userId);
    return {
      id: channel.id,
      external_id: channel.external_id,
      type: channel.type,
      name: channel.name,
      metadata: channel.metadata,
      archived_at: channel.archived_at?.toISOString() ?? null,
      // `null` when the tenant is asking: an application credential is not a member
      // of anything, and reporting `false` would imply it could become one.
      is_member: isMember,
    };
  }

  /** Archive and unarchive (chapter 3.15, FR-020, FR-020a).
   *
   * ACTION-STYLE, and a pair rather than a `PATCH` with a boolean: "archive this"
   * and "unarchive this" are two things a customer does, and a body carrying
   * `{"archived": false}` makes the client assemble a state instead of naming an
   * action. `POST …/ban` and `POST …/members/remove` take the same shape.
   *
   * The tenant's routes. A member does not archive the channel they are in.
   */
  @Post(":channelId/archive")
  @HttpCode(HttpStatus.OK)
  async archive(@Param("channelId") channelId: string) {
    return this.channels.setArchived(channelId, true);
  }

  @Delete(":channelId/archive")
  @HttpCode(HttpStatus.OK)
  async unarchive(@Param("channelId") channelId: string) {
    return this.channels.setArchived(channelId, false);
  }

  /** One member's role (chapter 3.15, FR-011, FR-011a).
   *
   * The tenant's route: an application credential decides who moderates. A member
   * cannot promote themselves, which is why this is not `@Accepts("user")` like
   * join.
   */
  @Patch(":channelId/members/:userExternalId")
  async setMemberRole(
    @Param("channelId") channelId: string,
    @Param("userExternalId") userExternalId: string,
    @Body(new ZodValidationPipe(setMemberRoleBodySchema)) body: SetMemberRoleBody,
  ) {
    return this.channels.setMemberRole(channelId, userExternalId, body.role);
  }

  /** Remove members, up to a hundred, reporting each (chapter 3.15, FR-006, FR-007).
   *
   * AN ACTION-STYLE `POST`, NOT `DELETE` WITH A BODY. A body on `DELETE` is legal
   * and unreliable — proxies and some clients drop it — and this feature already
   * sets the action-style precedent with `POST …/archive` and `POST …/ban`. The
   * singular `DELETE …/members/:userExternalId` the contract carried for ten
   * analysis passes is gone rather than kept beside this: "up to 100" covers one,
   * and two routes for one job is two classification entries, two tests and two
   * chances to disagree.
   */
  @Post(":channelId/members/remove")
  @HttpCode(HttpStatus.OK)
  async removeMembers(
    @Param("channelId") channelId: string,
    @Body(new ZodValidationPipe(removeMembersBodySchema)) body: RemoveMembersBody,
    @Req() req: RequestWithPrincipal,
  ) {
    const results = await this.channels.removeMembers(channelId, body);

    // ONLY THE ONES THAT CHANGED SOMETHING (FR-005). The route reports per entry and
    // `not_a_member` is a legitimate outcome, so publishing the whole list would tell
    // a gateway to revoke access nobody had — and would put a `membership.changed`
    // frame on a socket whose owner was never removed from anything.
    //
    // ONE PUBLISH, BOTH AUDIENCES. The removed user is still a member at the moment
    // this goes out, so the channel's subject reaches the remaining members and the
    // subject too (research R1). An addition is the case that cannot do this.
    //
    // AFTER the service returns, which is after the transaction that wrote both the
    // membership row and its outbox row. Constitution II forbids the other order and
    // the phase order exists for it.
    for (const removal of results) {
      if (removal.result !== "removed") continue;
      await this.membership.publish({
        environment: req.principal?.environmentId ?? "unknown",
        channel: channelId,
        user: removal.external_id,
        change: "removed",
      });
    }

    return { results };
  }

  /** The user-initiated half of FR-CHN-03 (chapter 3.15).
   *
   * `@Accepts("user")` AT THE METHOD, overriding the class's `"application"`. This
   * is the caller joining, not the tenant adding someone, so an application key has
   * no business here — it carries no user to join. `credential.guard.ts` resolves
   * `getAllAndOverride([handler, class])`, so the method wins.
   *
   * Without this decorator every user's join would be a 403, which is chapter
   * 3.12's FR-044 hole exactly: a credential mismatch that passed for a whole
   * chapter and then turned nine of fifteen tests red.
   */
  @Post(":channelId/join")
  @HttpCode(HttpStatus.OK)
  @Accepts("user")
  async join(
    @Param("channelId") channelId: string,
    @Req() req: RequestWithPrincipal,
  ) {
    // The guard has already refused anything that is not a user principal, so this
    // is narrowing for the type system rather than for trust.
    if (req.principal?.kind !== "user") {
      throw new BadRequestException("joining is an end user's action");
    }
    const user = await this.repo.getUserByExternalId(req.principal.userExternalId);
    if (!user) throw new BadRequestException("unknown user");
    return { result: await this.channels.join(channelId, user.id) };
  }

  /** Members by external id, users created on first membership (FR-CHN-04).
   *
   * 200 and not 201: this is idempotent in a way creation is not — a member list
   * sent twice is the same list, and the per-user `status` says which ones were
   * already there. */
  @Post(":channelId/members")
  @HttpCode(200)
  async addMembers(
    @Param("channelId") channelId: string,
    @Body(new ZodValidationPipe(addMembersBodySchema)) body: AddMembersBody,
  ) {
    return { members: await this.channels.addMembers(channelId, body) };
  }
}
