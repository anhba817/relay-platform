import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
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
import {
  editMessageBodySchema,
  historyQuerySchema,
  sendMessageBodySchema,
} from "./messages.schema";
// `import type` is required, not stylistic: with isolatedModules and
// emitDecoratorMetadata on (ADR-15's trade-off, chapter 1.4), a type used
// in a decorated signature must be imported as a type or TS1272 refuses
// to compile it.
import type { EditMessageBody, HistoryQuery, SendMessageBody } from "./messages.schema";
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
    // customer's own client calls. `MessagesController` declared no `@Accepts` at the
    // time, so the guard fell back to `EITHER` and a user token was accepted here.
    //
    // PAST TENSE SINCE CHAPTER 3.17, and it took until 3.23 to say so. That chapter
    // added `@Accepts("application", "user")` at :64 — twenty-five lines above this
    // sentence — and left three copies of the sentence describing its absence, here, in
    // `messages.itest.ts:161` and in `repository.ts:3999`. Nothing compares a comment
    // with the decorator it describes, and the chapter's own task named one of the three.
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

  /** Change what a message says (chapter 3.23, FR-001, FR-005, FR-013, FR-013a).
   *
   * `@Accepts("user")` ON THE METHOD, AND THE CLASS DECLARES BOTH (:64). A route added
   * here without a declaration INHERITS `("application", "user")` — the guard reads
   * `getAllAndOverride`, so the method-level one wins and its absence is not neutral.
   * An application credential reaching this handler would carry no user to compare the
   * author against, and the honest options at that point are to refuse it inside the
   * handler or to let a tenant key rewrite anybody's words as them. FR-013a chooses
   * neither: the credential class is refused at the guard, by declaration.
   *
   * FR-MOD-02 GRANTS A KEY DELETION OF ANY MESSAGE AND IS SILENT ON EDITING, and the
   * spec reads silence as absence of permission. Removing somebody's words and
   * rewriting them as them are different acts, and only the second leaves a message
   * saying something its author never wrote with nothing on the wire to say so.
   *
   * `dev-token.controller.ts:51` is the precedent for a method-level narrowing, and
   * `credential.guard.ts:31` argues why the class is DECLARED while the authorship is
   * CHECKED: authorship cannot be declared, because it is a fact about a row. */
  @Patch(":messageId")
  @Accepts("user")
  async edit(
    @Param("channelId") channelId: string,
    @Param("messageId") messageId: string,
    @Body(new ZodValidationPipe(editMessageBodySchema)) body: EditMessageBody,
    @Req() req: RequestWithPrincipal,
  ) {
    // THE GUARD ALREADY REFUSED ANYTHING BUT A USER TOKEN, so `actingUser` cannot be
    // undefined here — and the narrowing is a throw rather than a `!`, on
    // `messages.service.ts`'s precedent for the same shape. A `!` would put the
    // assumption in a place a later change to the decorator cannot invalidate.
    const actingExternalId = actingUser(req);
    if (actingExternalId === undefined) {
      throw new Error("a user token is required to edit (FR-013a, @Accepts on this route)");
    }
    const user = await this.repo.getUserByExternalId(actingExternalId);
    if (!user) {
      // The same refusal the send path gives for a token minted for an identifier with
      // no row: a user who is a member of nothing wrote nothing.
      throw new BadRequestException({
        code: "invalid_request",
        message: "the caller named in this token is not a user of this environment",
        field: "user",
      });
    }
    const edited = await this.messages.edit(channelId, messageId, body, user.id);

    // ── the live fan-out (chapter 3.23, FR-005, ADR-24) ──────────────────────
    //
    // AFTER THE COMMIT, BEFORE THE RESPONSE, for the reason the send path states at
    // :199: a request handler has one channel and the response IS the ack, so anything
    // awaited here precedes it. The row is durable before anyone hears about it.
    //
    // NO `duplicate` GUARD, AND THAT IS A DECISION rather than an omission (research
    // R8). The send path carries two guards because a recognised idempotent retry
    // wrote no row and must not be delivered twice. An edit has one entry path and no
    // idempotency key — the edit body takes none, deliberately — so there is no retry
    // for a guard to recognise. Copying the send path's `if` here would have added a
    // condition that is always true and read as though it were protecting something.
    //
    // NO `text !== null` GUARD EITHER, for a stronger reason: `editMessage` refuses a
    // tombstone (FR-010), so a null text cannot reach this line at all. The send
    // path's check exists because an idempotency key can recover one.
    //
    // `publishRevision`, NOT `publish` — the kind rides the payload now, and the
    // subject is the one ADR-24 took. A `publish` here would deliver the edit as a
    // creation to every member, because the `updated` arm's payload IS a `Message`.
    await this.fanout.publishRevision(
      {
        kind: "updated",
        message: {
          id: edited.id,
          // `channel`, not `channel_id`: the frame's field is `channel` and
          // `messageSchema` is a `z.strictObject`, so the wrong name delivers NOTHING
          // while this route answers 200. The send path records the same trap.
          channel: edited.channel_id,
          seq: edited.seq,
          user: actingExternalId,
          text: edited.text!,
          created_at: edited.created_at,
        },
      },
      {
        requestId: req.requestId ?? "unknown",
        environmentId: req.principal?.environmentId ?? "unknown",
      },
    );

    // THE FIELD LIST IS SPELLED OUT, like the send path's, so a new column joins the
    // public response only when somebody decides it should. `prior_text` is on the
    // repository's return and is NOT here: `not_message_author` exists because
    // rewriting somebody's words differs from removing them, and echoing the superseded
    // text to whoever asked would make the edit-history route's refusal (FR-023a) a
    // formality.
    return {
      id: edited.id,
      channel_id: edited.channel_id,
      seq: edited.seq,
      text: edited.text,
      created_at: edited.created_at,
      edited_at: edited.edited_at,
      user: actingExternalId,
    };
  }

  /** What a message used to say (chapter 3.23, FR-023, FR-023a).
   *
   * `@Accepts("application")` ON THE METHOD, AND WITHOUT IT A USER TOKEN READS THIS.
   * The class declares `("application", "user")` at :64 and the guard reads
   * `getAllAndOverride`, so an undeclared route here would hand every end user the
   * superseded text of every message in every channel they can see — the one thing
   * FR-023a exists to forbid. T033g falsifies it by removing the line and watching the
   * refusal test go red.
   *
   * **INCLUDING THE AUTHOR'S OWN MESSAGES.** That a message was edited is public — the
   * read path carries `edited_at` — and what it used to say is not. FR-MOD-01 names the
   * audience for a moderation surface and nothing in the SRS asks for an end-user one.
   *
   * 200 WITH AN EMPTY LIST, NOT 404, for a message that has never been edited. The
   * absence of edits is a fact about the message rather than the absence of a resource,
   * and the two are distinguishable here because `messageExistsIn` answers the second
   * question separately — `listMessageEdits` returning `[]` cannot tell them apart. */
  @Get(":messageId/edits")
  @Accepts("application")
  async edits(
    @Param("channelId") channelId: string,
    @Param("messageId") messageId: string,
  ): Promise<{ edits: Array<{ prior_text: string; edited_at: string }> }> {
    // NO `userId`, AND THAT IS THE DECLARATION SPEAKING. Only an application credential
    // reaches this handler, so there is no member to resolve and no membership to
    // check; `channelVisibleTo(channelId, undefined)` is the tenant reading, which sees
    // everything it owns. Passing a user here would be inventing a caller.
    if (!(await this.repo.channelVisibleTo(channelId))) {
      throw new NotFoundException("channel not found");
    }
    if (!(await this.repo.messageExistsIn(channelId, messageId))) {
      throw new NotFoundException("message not found");
    }
    return { edits: await this.repo.listMessageEdits(channelId, messageId) };
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
