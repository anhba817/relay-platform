import {
  BadRequestException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { protocolError } from "../protocol-error";

import {
  ChannelArchivedError,
  UserBannedError,
  ChannelNotFoundError,
  Repository,
  type MessageRow,
  type MessageWithSender,
  SenderNotPermittedError,
} from "../db/repository";
import { QuotaExceededError } from "../quotas/quota.error";
import { decodeCursor, encodeCursor } from "./cursor";
import type { HistoryQuery, SendMessageBody } from "./messages.schema";

// The thin layer between HTTP and the repository (chapters 2.2 + 2.3). It
// owns two things: turning the layer's domain error into the wire's 404,
// and carrying the write path's inputs down to the repository.
//
// AMENDED in chapter 2.6: `duplicate` used to be erased here, which made
// FR-MSG-04's "indistinguishable retry" a property of the SERVICE. It is
// really a property of the PUBLIC WIRE — the internal caller needs the
// flag to avoid publishing a retry to every member. So the flag now
// travels to the controllers, and the public one erases it.
@Injectable()
export class MessagesService {
  constructor(private readonly repo: Repository) {}

  async send(
    channelId: string,
    body: SendMessageBody,
    /** Chapter 2.6: who wrote it. Optional because an APPLICATION-key send is
     * unattributed — it acted for the tenant and there was no user to name. **That is no
     * longer true**: chapter 3.17 made every message carry a sender (FR-MSG-15), and a key
     * names a bot user of its tenant. The parameter below is required at the repository and
     * resolved by the controller before this method is called.
     *
     * IT IS NO LONGER OPTIONAL FOR A USER TOKEN. Chapter 3.15 made the public
     * route resolve its principal (T031a): the membership check in `sendMessage`
     * is gated on this parameter, and until then the public route supplied none,
     * so the check could not fire on the route a customer's client actually calls.
     * "A key-authenticated public send is unattributed" was the old bound and it
     * described the whole route; now it describes one of its two credentials. */
    userId?: string,
    /** Chapter 3.3: the same person as a CONSUMER will see them. The event
     * envelope carries external ids, and the internal route already holds this
     * one — it is the token's subject — so threading it costs nothing where a
     * lookup inside the write transaction would cost a query per message. */
    userExternalId?: string,
    /** Whether the caller is an application credential (chapter 3.17, FR-007, T030).
     *
     * A BOOLEAN, NOT THE PRINCIPAL. The service needs one fact to apply the bot rule and
     * has no business holding the request; the controller is what knows about credential
     * classes. Passed through to the repository as `senderMustBeBot`, which knows even
     * less — only that this send's sender has to be software (R5). */
    senderMustBeBot = false,
  ): Promise<MessageRow> {
    try {
      // THE SENDER IS RESOLVED BEFORE HERE (chapter 3.17, FR-008). The controller does
      // it per credential class and refuses an absent or unresolvable one with a 400
      // naming `user`, so by this line there is a sender and it exists in this tenant.
      // What remains is the narrowing the compiler needs.
      if (userId === undefined) {
        throw new Error("a message must name its sender (FR-MSG-15, FR-008)");
      }
      return await this.repo.sendMessage(channelId, {
        text: body.text,
        metadata: body.metadata,
        userId,
        senderMustBeBot,
        ...(userExternalId !== undefined && { userExternalId }),
        ...(body.idempotency_key != null && {
          idempotencyKey: body.idempotency_key,
        }),
      });
    } catch (error) {
      // THE BAN, FIRST IN THE ORDER AND FIRST IN THE MAPPING (FR-031, FR-021a).
      //
      // 403 `user_banned`, and it is thrown before the channel is resolved — so this
      // refusal is the same for a channel that exists, one that belongs to another
      // tenant, and one that was invented. The gauntlet asserts exactly that pair.
      //
      // NOT the not-found envelope, unlike the private-channel refusal. A ban is a fact
      // about the CALLER, not about the channel, so saying so reveals nothing about what
      // channels exist — and a client that cannot tell "you are banned" from "no such
      // channel" retries for ever against a wall.
      // 403 `sender_not_permitted`, AND NOT `forbidden` (chapter 3.17, FR-007a, T032a).
      //
      // `ProtocolErrorFilter` maps a bare 403 to `forbidden`, and this is the only code
      // in the chapter that collides with the ladder — so it is named here, the way
      // chapter 3.12 named `wrong_credential_service` for the same reason. The filter
      // prefers an explicit code when one is given; leaving it to the ladder would put
      // "you lack a permission" on the wire in place of the one fact an integrator can
      // act on.
      //
      // THE MESSAGE NAMES NOBODY. Not the person asked for, not the bots that would
      // have worked. Which identifiers exist in a tenant is what the oracle exists to
      // keep out of a refusal (SC-005).
      if (error instanceof SenderNotPermittedError) {
        throw protocolError(
          "sender_not_permitted",
          "an application credential may send only as a bot user; name one in `user`",
          HttpStatus.FORBIDDEN,
        );
      }
      if (error instanceof UserBannedError) {
        throw protocolError(
          "user_banned",
          "this user is banned in this environment and cannot send messages",
          HttpStatus.FORBIDDEN,
        );
      }
      if (error instanceof ChannelArchivedError) {
        // 403 AND ITS OWN CODE (FR-021). Distinct from not-found, because the
        // channel is there and the caller can see it, and distinct from
        // `user_banned`, because one lifts when somebody unarchives and the other
        // when somebody unbans. A client that cannot tell them apart retries the
        // wrong one for ever.
        throw protocolError(
          "channel_archived",
          "this channel is archived and accepts no new messages; its history is unchanged",
          HttpStatus.FORBIDDEN,
        );
      }
      if (error instanceof ChannelNotFoundError) {
        // A CONSTANT message: echoing the id back would make the foreign-id
        // answer differ from the missing-id answer, and "different" is
        // itself a disclosure (FR-TEN-05).
        throw new NotFoundException("channel not found");
      }
      if (error instanceof QuotaExceededError) {
        // ONE THROW, AND IT IS THE ONLY ONE (chapter 3.10, FR-RTL-08).
        //
        // Both send routes reach this method — `internal.controller.ts` calls
        // `messages.send`, the public controller calls it too — so there is one
        // place to refuse from. An earlier draft of the plan costed "two
        // controller mappings"; this service has no per-controller mappings to
        // add one to, and adding two would be the drift EIR-API-04 and
        // `ProtocolErrorFilter` exist to prevent (research R3).
        //
        // `402`, NOT `429`. Chapter 3.8 owns `429`, and a client that sleeps for
        // `Retry-After` and retries is behaving correctly for a rate limit and
        // wrongly for a quota — which will still be exhausted in an hour and in
        // three weeks. There is a time at which sends resume and it is in the
        // message, not in a header a client will act on.
        //
        // THE CODE IS NAMED HERE, and it has to be. `ProtocolErrorFilter` infers
        // a code from the status for 400, 401, 403 and 404, and everything else
        // becomes `internal_error` — so an unnamed `402` would emit a body
        // calling itself an internal error while carrying a `402`. That is the
        // lie chapter 2.2 fixed for 400 and chapter 3.2 for 403, and 3.2's
        // mechanism — a thrower naming its own code — is what this uses. The
        // filter builds the four-field envelope and derives `docs_url` from the
        // code.
        throw protocolError(
          "quota_exceeded",
          error.publicMessage(),
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      throw error;
    }
  }

  /** A page of history (chapter 2.4). The cursor is opaque coming in and
   * going out; the service is the only place that knows it encodes a
   * sequence. A cursor we did not mint is a 400, never a silent reset to
   * the top — serving the wrong page quietly is worse than refusing. */
  async history(
    channelId: string,
    { cursor, direction, limit }: HistoryQuery,
    /** Who is reading (chapter 3.15, FR-002). Threaded for the same reason `send`
     * threads it: the membership check lives in the repository, and a check gated
     * on a parameter no caller fills in is a check that never fires. This route
     * dropped the caller for twenty-three chapters — the same defect as the send
     * path on the same controller, found one analysis pass later. */
    userId?: string,
  ): Promise<{
    messages: MessageWithSender[];
    next_cursor: string | null;
    prev_cursor: string | null;
  }> {
    // A channel that does not resolve in this tenant is a 404 here, exactly
    // as it is on the send path (chapter 2.8's finding). An empty page would
    // not leak anything — a foreign channel and an empty one would look the
    // same — but it leaves a client unable to tell "no such conversation"
    // from "no messages yet", and it made one resource answer two ways
    // depending on the verb.
    // VISIBILITY, NOT EXISTENCE (chapter 3.15, FR-003). `channelExists` answered
    // only the first half, and the difference was a leak: an absent channel gave
    // 404 while a private channel a non-member read gave 200 with an empty page.
    // One predicate now produces both refusals, so the two answers cannot diverge.
    if (!(await this.repo.channelVisibleTo(channelId, userId))) {
      throw new NotFoundException("channel not found");
    }

    let anchor: number | undefined;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor);
      if (decoded === null) throw new BadRequestException("malformed cursor");
      anchor = decoded;
    }
    const messages = await this.repo.listMessages(channelId, {
      ...(userId !== undefined && { userId }),
      limit,
      ...(direction === "newer"
        ? { afterSeq: anchor ?? 0 }
        : anchor === undefined
          ? {}
          : { beforeSeq: anchor }),
    });
    // Edge rows become the next anchors. A short page still yields a
    // next_cursor: "no more yet" and "no more ever" are the same answer
    // in a feed that keeps growing, and the client simply gets an empty
    // page next time.
    const first = messages[0];
    const last = messages[messages.length - 1];
    return {
      messages,
      next_cursor: last ? encodeCursor(last.seq) : null,
      prev_cursor: first ? encodeCursor(first.seq) : null,
    };
  }
}
