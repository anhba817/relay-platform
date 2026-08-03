import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UseGuards,
} from "@nestjs/common";

import { EnvironmentContextGuard } from "../messages/environment-context.guard";
import { MessagesService } from "../messages/messages.service";
import { Repository } from "../db/repository";
import {
  internalSendRequestSchema,
  type InternalSendRequest,
} from "@relay/protocol";

import { ZodValidationPipe } from "../messages/zod-validation.pipe";

// The internal surface (chapter 2.5): the routes the gateway calls on a
// connected user's behalf. They reuse the SAME service methods as the
// public routes — the write path has one implementation (ADR-04), and the
// socket is a new door onto it, not a second path.
//
// DECISION (chapter 2.5): these routes are network-internal and
// unauthenticated between services at this stage; the gateway's forwarded
// identity headers are trusted. Service-to-service credentials are Part 3
// hardening, and this controller is the whole seam.
@Controller("internal")
@UseGuards(EnvironmentContextGuard)
export class InternalController {
  constructor(
    private readonly repo: Repository,
    private readonly messages: MessagesService,
  ) {}

  /** Which channels may this user hear? The gateway caches the answer on
   * the session; membership.changed frames invalidate it (FR-RTM-05). */
  @Get("memberships")
  async memberships(@Headers("x-relay-user") userExternalId?: string) {
    if (!userExternalId) throw new BadRequestException("missing x-relay-user");
    const user = await this.repo.getUserByExternalId(userExternalId);
    // An unknown user is not an error — it is a user with no channels. The
    // gateway's job is delivery, not identity forensics.
    if (!user) return { channel_ids: [] };
    return { channel_ids: await this.repo.channelsForUser(user.id) };
  }

  @Post("messages")
  async send(
    @Body(new ZodValidationPipe(internalSendRequestSchema))
    body: InternalSendRequest,
    @Headers("x-relay-user") userExternalId?: string,
  ) {
    if (!userExternalId) throw new BadRequestException("missing x-relay-user");
    const user = await this.repo.getUserByExternalId(userExternalId);
    if (!user) throw new BadRequestException("unknown user");
    return this.messages.send(body.channel_id, {
      text: body.text,
      ...(body.idempotency_key !== undefined && {
        idempotency_key: body.idempotency_key,
      }),
    });
  }
}
