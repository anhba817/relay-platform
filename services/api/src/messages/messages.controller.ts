import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import { Repository } from "../db/repository";
import { MessagesService } from "./messages.service";
import {
  MESSAGE_PUBLISHER,
  type MessagePublisher,
} from "../fanout/publisher";
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
 * routes accept both credential classes — declared as `@Accepts("application", "user")`
 * since chapter 3.17, rather than inherited from `credential.guard.ts`'s `EITHER`
 * fallback — and an application key carries no user OF ITS OWN.
 *
 * THIS COMMENT SAID SOMETHING ELSE UNTIL CHAPTER 3.17, and what it said was the reading
 * that made the gap invisible: *"A tenant's own server sending on a customer's behalf is
 * FR-MSG-13, not a mistake."* FR-MSG-13 said the system shall support sending **on behalf
 * of a user**, and this route named nobody — so the clause was cited for eleven chapters
 * by the code that did the opposite of it. The clause is now narrowed to a bot user of
 * that tenant, and the sender comes from the body (`user`), resolved below. */
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
// accepted (FR-MSG-13 lets a server send on behalf of a bot user of its tenant, and
// FR-AUT-10 does not reserve these routes) — and chapter 3.17 made that a DECLARATION
// rather than a fallback, because a fallback is what let the gateway's credential reach
// `POST /internal/dispatch/replay` in chapter 3.12.
// DECLARED, NOT INHERITED FROM A FALLBACK (chapter 3.17, T027a). Until now this class
// declared no `@Accepts` and `credential.guard.ts` fell back to `EITHER` — the fallback
// its own comment names as the thing that let the gateway's credential reach
// `POST /internal/dispatch/replay` in chapter 3.12. Both classes are genuinely accepted
// here, so the declaration says the same thing the fallback did and says it on purpose.
@Controller("v1/channels/:channelId/messages")
@Accepts("application", "user")
@UseGuards(CredentialGuard)
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly repo: Repository,
    // Chapter 3.18. INJECTED HERE AND NOT INTO THE SERVICE, because two callers
    // reach `MessagesService.send` — this route and `internal.controller.ts`,
    // which is the gateway's — and the gateway publishes for its own path
    // already. A publish in the service would put every socket-sent message on
    // every member's screen twice (FR-006).
    @Inject(MESSAGE_PUBLISHER) private readonly fanout: MessagePublisher,
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
    // THE SENDER, RESOLVED PER CREDENTIAL CLASS (chapter 3.17, FR-010, FR-008).
    //
    // A user token attributes to its subject and MAY NOT name anybody else: a token is
    // both an authorisation and an attribution, so a body `user` beside one is either a
    // mistake or an attempt to post as someone else, and both deserve the same refusal.
    //
    // An application credential carries no user of its own, so the body's `user` is the
    // only thing that can name one — and naming nothing is refused, because FR-MSG-15
    // says every message has a sender.
    //
    // THE SENDER ATTRIBUTES; IT DOES NOT AUTHORISE (FR-019). What a key may reach is
    // decided by the key. Naming a bot does not widen that, and the repository's
    // private-channel check turns on the sender's `kind` for exactly this reason.
    const tokenSubject = actingUser(req);
    if (tokenSubject !== undefined && body.user !== undefined) {
      throw new BadRequestException({
        code: "invalid_request",
        message:
          "a user token is already attributed to its subject; remove `user` from the body",
        field: "user",
      });
    }
    const actingExternalId = tokenSubject ?? body.user;
    if (actingExternalId === undefined) {
      throw new BadRequestException({
        code: "invalid_request",
        message: "name the sender in `user` — an application credential has no user of its own",
        field: "user",
      });
    }
    // ONE THROW FOR BOTH FAILURES, WHICH IS THE INDISTINGUISHABILITY (T031, SC-005).
    //
    // An identifier belonging to another tenant and an identifier belonging to nobody
    // are the same answer here, because there is only one place that answers. Resolving
    // the id per tenant is what `getUserByExternalId` already does — a foreign bot is
    // simply absent from this environment — so the two cannot diverge by construction
    // rather than by two branches that happen to agree today.
    //
    // The message names no identifier. A bot's external id is often its purpose spelled
    // out, so echoing it back would say "this exists somewhere" about the one string the
    // caller most wants confirmed.
    const user = await this.repo.getUserByExternalId(actingExternalId);
    if (!user) {
      throw new BadRequestException({
        code: "invalid_request",
        message: "the sender named in `user` is not a user of this environment",
        field: "user",
      });
    }
    const message = await this.messages.send(
      channelId,
      body,
      user.id,
      actingExternalId,
      // The class the credential presented, so the service can apply the bot rule
      // without learning what a credential is (R5). A boolean rather than the
      // principal: the service needs one fact, not the request.
      tokenSubject === undefined,
    );
    // FR-MSG-04's "201-equivalent semantics" lives HERE, on the public
    // wire: the client sees the same body whether this was the original
    // send or the retry that recovered it. Moved down from the service in
    // chapter 2.6, where an internal caller turned out to need the flag.
    // The field list is spelled out rather than spread-minus-`duplicate`,
    // so a new column joins the public response only when someone decides
    // it should.
    // ── the live fan-out (chapter 3.18, FR-004) ────────────────────────────
    //
    // AFTER THE COMMIT, BEFORE THE RESPONSE. `docs/05-sad.md` says the fan-out
    // happens "after the ack", and a socket can do that literally — it writes an
    // ack frame and then publishes, because it has two channels. A request
    // handler has one: the response IS the ack, so anything awaited here
    // precedes it. FR-005 was amended to split by transport rather than pretend
    // otherwise. What the sentence protects survives either way: the row is
    // durable before anyone hears about it.
    //
    // Not in a `finally`, and not in the service's `try`. A refused send throws
    // out of `this.messages.send` above and never reaches this line, which is
    // FR-008 by construction rather than by a flag.
    //
    // TWO GUARDS, both mirrored from `session.ts:651`, both load-bearing:
    //
    //   !duplicate    A RECOGNISED RETRY WROTE NO ROW. 2.3 made the retry safe
    //                 for storage; that did not make it safe for delivery, and a
    //                 client retrying on a flaky link would otherwise put the
    //                 same message on every member's screen twice.
    //   text !== null A tombstone recovered by an old idempotency key is not a
    //                 creation. It has a second, independent reason here:
    //                 `messageSchema.text` is `z.string()`, not nullable, so a
    //                 tombstone could not be published anyway — the far end
    //                 would drop it as an invalid payload while this route
    //                 answered 201.
    if (!message.duplicate && message.text !== null) {
      await this.fanout.publish(
        {
          id: message.id,
          // `channel`, not `channel_id`. The frame's field is `channel`, and
          // `messageSchema` is a `z.strictObject` — publishing `channel_id`
          // would deliver NOTHING while this route still answered 201.
          channel: message.channel_id,
          seq: message.seq,
          user: actingExternalId,
          text: message.text,
          created_at: message.created_at,
        },
        {
          requestId: req.requestId ?? "unknown",
          environmentId: req.principal?.environmentId ?? "unknown",
        },
      );
    }

    return {
      id: message.id,
      channel_id: message.channel_id,
      seq: message.seq,
      text: message.text,
      created_at: message.created_at,
      // THE SENDER IT USED (chapter 3.17, FR-009a). A caller now required to name one
      // gets told which was recorded — and for a user token, which it inferred. The
      // internal send has carried this since chapter 2.6; the public one answered five
      // fields and left the caller to assume.
      user: actingExternalId,
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
