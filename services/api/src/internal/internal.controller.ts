import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { RequestWithPrincipal } from "../auth/principal";
import { MessagesService } from "../messages/messages.service";
import { Repository } from "../db/repository";
import {
  internalSendRequestSchema,
  type InternalSendRequest,
} from "@relay/protocol";

import { ZodValidationPipe } from "../messages/zod-validation.pipe";

/** The connected user, from the token the gateway forwarded. The guard has
 * already refused anything that is not a user principal, so this narrowing is
 * about the type system rather than about trust. */
function principalUser(req: RequestWithPrincipal): string {
  const principal = req.principal;
  if (principal?.kind !== "user") {
    throw new BadRequestException("internal routes act for an end user");
  }
  return principal.userExternalId;
}

// The internal surface (chapter 2.5): the routes the gateway calls on a
// connected user's behalf. They reuse the SAME service methods as the
// public routes — the write path has one implementation (ADR-04), and the
// socket is a new door onto it, not a second path.
//
// DECISION (chapter 2.5, narrowed by 3.2): these routes are still
// network-internal, and there is still no service-to-service credential between
// the gateway and the api — that remains Part 3 hardening. What changed is what
// they trust. The gateway used to ASSERT identity in two headers it invented
// from a token it verified locally; it now forwards the END USER'S OWN token,
// and the api resolves the identity itself. The seam got narrower, not wider:
// the gateway can no longer claim to be somebody it cannot present a token for.
@Controller("internal")
// The end user's token, not a key: these routes exist to act for a connected
// person, and a route that also accepted an application credential would let a
// key act as any user without saying which (research R6).
@Accepts("user")
@UseGuards(CredentialGuard)
export class InternalController {
  constructor(
    private readonly repo: Repository,
    private readonly messages: MessagesService,
  ) {}

  @Post("messages")
  async send(
    @Body(new ZodValidationPipe(internalSendRequestSchema))
    body: InternalSendRequest,
    @Req() req: RequestWithPrincipal,
  ) {
    const userExternalId = principalUser(req);
    const user = await this.repo.getUserByExternalId(userExternalId);
    if (!user) throw new BadRequestException("unknown user");
    const message = await this.messages.send(
      body.channel_id,
      {
        text: body.text,
        ...(body.idempotency_key !== undefined && {
          idempotency_key: body.idempotency_key,
        }),
      },
      // Chapter 2.6: the sender is RESOLVED here and, until now, dropped
      // here — every socket-written row had user_id NULL. Fan-out cannot
      // build a message.created frame without a sender, so the write path
      // finally records the one it already had in its hand.
      user.id,
      // Chapter 3.3: and the external id travels too, because the event this
      // write now emits is read by customers, who know users by that name.
      userExternalId,
    );
    // `user` is echoed as the EXTERNAL id: internal uuids are ours, and
    // the frame this becomes is client-facing.
    return { ...message, user: userExternalId };
  }
}
