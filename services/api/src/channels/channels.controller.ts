import { Body, Controller, HttpCode, Param, Post, Res, UseGuards } from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";
import { ChannelsService } from "./channels.service";
import { addMembersBodySchema, createChannelBodySchema } from "./channels.schema";
import type { AddMembersBody, CreateChannelBody } from "./channels.schema";

// THE PUBLIC CHANNEL SURFACE (FR-016, FR-019, data-model.md §7).
//
// `@Accepts("application")` and not both classes: creating a channel and deciding
// who is in it are server-side acts. An end-user token is minted for one person
// (FR-AUT-10), and a person adding themselves to a channel is a product decision
// this chapter is not making — chapter 3.13 owns the user-facing surface.
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
  constructor(private readonly channels: ChannelsService) {}

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
