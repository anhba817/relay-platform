import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";

import { CredentialGuard } from "../auth/credential.guard";
import { Repository } from "../db/repository";
import { MessagesService } from "./messages.service";
import { historyQuerySchema, sendMessageBodySchema } from "./messages.schema";
// `import type` is required, not stylistic: with isolatedModules and
// emitDecoratorMetadata on (ADR-15's trade-off, chapter 1.4), a type used
// in a decorated signature must be imported as a type or TS1272 refuses
// to compile it.
import type { HistoryQuery, SendMessageBody } from "./messages.schema";
import type { RequestWithPrincipal } from "../auth/principal";
import { ZodValidationPipe } from "./zod-validation.pipe";

/** The end user this request acts for, or `undefined` when the tenant is acting.
 *
 * SOFT, unlike `internal.controller.ts`'s `principalUser`, which throws. These two
 * routes accept BOTH credential classes — the class-level guard declares no
 * `@Accepts`, so `credential.guard.ts` falls back to `EITHER` — and an application
 * key legitimately carries no user. A tenant's own server sending on a customer's
 * behalf is FR-MSG-13, not a mistake. */
function actingUser(req: RequestWithPrincipal): string | undefined {
  return req.principal?.kind === "user" ? req.principal.userExternalId : undefined;
}

// The api's first product endpoint (chapter 2.2). Validation is zod at the
// boundary — the same schema family as @relay/protocol, so the REST body
// and the WebSocket frame payload cannot drift (1.3's payoff, again).
//
// Chapter 3.2 swapped the guard. `EnvironmentContextGuard` resolved a tenant
// from a header the caller asserted; `CredentialGuard` only asks whether the
// principal the middleware already resolved is allowed here. Both classes are
// (FR-MSG-13 lets a server send on a user's behalf, and FR-AUT-10 does not
// reserve these routes), so this one declares nothing narrower.
@Controller("v1/channels/:channelId/messages")
@UseGuards(CredentialGuard)
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly repo: Repository,
  ) {}

  @Post()
  async send(
    @Param("channelId") channelId: string,
    @Body(new ZodValidationPipe(sendMessageBodySchema)) body: SendMessageBody,
    @Req() req: RequestWithPrincipal,
  ) {
    // WHO IS SENDING, resolved here (chapter 3.15, FR-001, T031a).
    //
    // This route called `this.messages.send(channelId, body)` with no user for
    // twenty-three chapters, and the membership check in `sendMessage` is gated on
    // `userId` being present — so the check could not fire on the only send path a
    // customer's own client calls. `MessagesController` declares no `@Accepts`, so
    // the guard falls back to `EITHER` and a user token is accepted here.
    //
    // A LOOKUP PER SEND, and it is the same one the internal route already pays.
    // `sendMessage`'s own comment explains why the id is threaded rather than
    // resolved inside the write transaction: a SELECT in there is a cost every
    // message pays forever. Outside it, once, is what `internal.controller.ts`
    // does at line 63.
    //
    // A USER TOKEN FOR AN IDENTIFIER WITH NO ROW IS REFUSED, and this is a
    // behaviour change worth naming. `POST /auth/dev-token` mints tokens for
    // identifiers that need not exist, so before this a token-authenticated send
    // by a stranger succeeded UNATTRIBUTED — and an unattributed send is one the
    // membership check waves through. A user with no row is a member of nothing;
    // refusing is the honest answer, and it is the same one the internal route has
    // given since chapter 2.6. FR-039a removes the case entirely by creating the
    // row when the token is minted.
    const actingExternalId = actingUser(req);
    let userId: string | undefined;
    if (actingExternalId !== undefined) {
      const user = await this.repo.getUserByExternalId(actingExternalId);
      if (!user) throw new BadRequestException("unknown user");
      userId = user.id;
    }
    const message = await this.messages.send(
      channelId,
      body,
      userId,
      actingExternalId,
    );
    // FR-MSG-04's "201-equivalent semantics" lives HERE, on the public
    // wire: the client sees the same body whether this was the original
    // send or the retry that recovered it. Moved down from the service in
    // chapter 2.6, where an internal caller turned out to need the flag.
    // The field list is spelled out rather than spread-minus-`duplicate`,
    // so a new column joins the public response only when someone decides
    // it should.
    return {
      id: message.id,
      channel_id: message.channel_id,
      seq: message.seq,
      text: message.text,
      created_at: message.created_at,
    };
  }

  @Get()
  async history(
    @Param("channelId") channelId: string,
    @Query(new ZodValidationPipe(historyQuerySchema)) query: HistoryQuery,
    @Req() req: RequestWithPrincipal,
  ) {
    // The same resolution the send handler above does, on the other route of this
    // controller (chapter 3.15, T041a). Both dropped the caller; the send path was
    // found in one analysis pass and this one in the next, because finding the first
    // did not prompt anyone to ask whether the sibling had the same shape.
    const actingExternalId = actingUser(req);
    let userId: string | undefined;
    if (actingExternalId !== undefined) {
      const user = await this.repo.getUserByExternalId(actingExternalId);
      if (!user) throw new BadRequestException("unknown user");
      userId = user.id;
    }
    return this.messages.history(channelId, query, userId);
  }
}
