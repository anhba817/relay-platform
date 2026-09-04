import { z } from "zod";

import { attachmentSchema, MAX_ATTACHMENTS } from "./attachments.js";

// The wire contract, one home (ADR-01). Every frame is a JSON object with a
// `type` discriminator and a `payload` (EIR-WS-02). Schemas are the single
// source of truth: every exported static type is inferred from its schema,
// so the types and the validation cannot drift — there is no second
// definition. Payloads are strict: unknown fields are rejected.

/** Per-channel resume cursor: { channel_id: highest seq seen } (ADR-03). */
export const cursorSchema = z.record(z.string(), z.number().int().positive());

/** The message on the wire — derived from the SAD §6.1 `messages` columns.
 * Wire spellings follow SAD §5.1's own frame line (`channel`, `seq`).
 * metadata/edit/tombstone fields arrive with Part 2/4; attachments arrived
 * with chapter 3.24, which is why this comment no longer schedules them. */
export const messageSchema = z.strictObject({
  id: z.string().min(1),
  channel: z.string().min(1),
  seq: z.number().int().positive(),
  user: z.string().min(1),
  text: z.string(),
  /** REQUIRED, AND NOT OPTIONAL, and that is the whole of FR-022 (3.24).
   *
   * An optional field parses a payload that omits it, so a construction site
   * nobody widened delivers a message whose attachments are simply absent —
   * green tests, silent loss. Required means the compiler names every site
   * instead: `pnpm --filter @relay/protocol build`, then `tsc --noEmit` in the
   * api and the gateway, lists four in production and 28 in tests.
   *
   * FR-007 (3.24): a message with none carries `[]` rather than an absent key,
   * so a reader needs no special case. `?? []` at the read sites, never `?? null`. */
  attachments: z.array(attachmentSchema),
  created_at: z.iso.datetime(), // UTC, RFC 3339 (constitution: timestamps)
});

/** Server → client on successful handshake (EIR-WS-03, SAD §5.2). Sent after
 * backfill is fetched, so it can also carry the per-channel truncation list
 * (FR-RTM-04) — channels where backfill exceeded 500 and the client must
 * refetch history instead. */
export const connectionAckSchema = z.strictObject({
  type: z.literal("connection.ack"),
  payload: z.strictObject({
    user: z.string().min(1),
    cursor: cursorSchema,
    resume_ok: z.boolean(),
    truncated: z.array(z.string().min(1)),
  }),
});

/** Client → server send (SAD §5.1: `message.send {idem_key, channel, text}`).
 * The idempotency key is client-supplied (FR-SDK-06), deduplicated
 * server-side within 24 h (FR-MSG-04). */
export const messageSendSchema = z.strictObject({
  type: z.literal("message.send"),
  payload: z.strictObject({
    idem_key: z.string().min(1).max(255),
    channel: z.string().min(1),
    text: z.string(),
    /** OPTIONAL here and required on the outbound `messageSchema`, which is not an
     * inconsistency: a caller may send none, and a payload the platform BUILDS must
     * always say. The bound is imported rather than spelled — two schemas that happen
     * to agree are what `idem_key` against `idempotency_key` looks like three chapters
     * later. */
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
  }),
});

/** Server → sender after commit — never before (SAD §5.1, FR-MSG-05). */
export const messageAckSchema = z.strictObject({
  type: z.literal("message.ack"),
  payload: z.strictObject({
    seq: z.number().int().positive(),
  }),
});

// The six real-time event kinds (FR-RTM-05). The kinds are the SRS's; the
// `noun.verb` spellings are this chapter's recorded decision, following the
// documents' own connection.ack / message.send naming.

export const messageCreatedSchema = z.strictObject({
  type: z.literal("message.created"),
  payload: messageSchema,
});

export const messageUpdatedSchema = z.strictObject({
  type: z.literal("message.updated"),
  payload: messageSchema,
});

/** THE ONE FRAME THAT DOES NOT CARRY A MESSAGE, and chapter 3.23 is where that became
 * unavoidable rather than tidy.
 *
 * `messageSchema.text` is `z.string()`. A deleted message has no text — FR-MSG-08 replaces
 * it with a tombstone — so this frame's payload could never be filled. Two places in the
 * api already refused to try and said so: `messages.controller.ts` declines to publish a
 * recovered tombstone because *"`messageSchema.text` is `z.string()`, not nullable"*, and
 * `backfill.controller.ts` drops one from a resume because *"a tombstone is not a
 * creation"*. Both were waiting for this.
 *
 * **`messageSchema` IS NOT WIDENED, and that is the decision.** Making `text` nullable
 * would let a CREATION carry a null text — which the send path deliberately refuses — and
 * would edit a contract published since chapter 1.3 that every client in the series parses.
 * The event that has no message is the one that stops carrying one.
 *
 * NO `text` FIELD AT ALL, not an empty string. An empty message and a deleted one would be
 * indistinguishable on the wire, and the platform would be asserting something false rather
 * than declining to say it. */
/** NAMED SEPARATELY so the fabric can import it instead of reaching into
 * `messageDeletedSchema.shape.payload`. Chapter 3.23's fifth subject grammar carries this
 * exact shape, and one declaration is what stops the two drifting. */
export const messageDeletedPayloadSchema = z.strictObject({
  id: z.string().min(1),
  channel: z.string().min(1),
  seq: z.number().int().positive(),
  /** The AUTHOR, which the tombstone keeps (FR-MSG-08). Not whoever deleted it — a tenant
   * key may delete anybody's message, so the remover is a different fact and lives in
   * `messages.metadata` rather than on the wire. */
  user: z.string().min(1),
  deleted_at: z.iso.datetime(),
});

export const messageDeletedSchema = z.strictObject({
  type: z.literal("message.deleted"),
  payload: messageDeletedPayloadSchema,
});

export const membershipChangedSchema = z.strictObject({
  type: z.literal("membership.changed"),
  payload: z.strictObject({
    channel: z.string().min(1),
    user: z.string().min(1),
    change: z.enum(["added", "removed"]),
  }),
});

/** Presence states per FR-RTM-06; delivery scope is FR-RTM-07's concern. */
export const presenceChangedSchema = z.strictObject({
  type: z.literal("presence.changed"),
  payload: z.strictObject({
    user: z.string().min(1),
    state: z.enum(["online", "offline"]),
  }),
});

/** Expires after 5 s without renewal and is never persisted (FR-RTM-08). */
export const typingSchema = z.strictObject({
  type: z.literal("typing"),
  payload: z.strictObject({
    channel: z.string().min(1),
    user: z.string().min(1),
  }),
});

/** CLIENT → SERVER: "I am typing in this channel" (chapter 3.21, FR-001).
 *
 * **`typing.send`, and the name is an argument.** `typing.start` would read as a
 * state machine with a missing `typing.stop` — and `typing.stop` is exactly the
 * frame this protocol does not have, because `typingSchema` above carries no
 * `state` field and the expiry therefore belongs to the receiving client
 * (FR-009). A name that says *signal* rather than *state* keeps that honest.
 *
 * The `.send` suffix is the other half: `message.send` is the only inbound frame
 * this protocol had for twenty chapters, so the inbound set becomes
 * `{ message.send, typing.send }` and **the rule is legible — an inbound frame
 * ends in `.send`**. FR-003 asks for a named set rather than a list, and a set
 * with a spelling rule is one a reader can extend correctly.
 *
 * **NO `user` IN THE PAYLOAD, AND THE ABSENCE IS THE SECURITY PROPERTY**
 * (data-model §2, FR-006). The connection supplies the identity; a client that
 * could name a user could type as anybody. `typingSchema` carries a `user`
 * because the SERVER fills it in on the way out. */
export const typingSendSchema = z.strictObject({
  type: z.literal("typing.send"),
  payload: z.strictObject({
    channel: z.string().min(1),
  }),
});

/** Protocol-level error — EIR-API-04's error shape, reused on the socket
 * (chapter 1.3's recorded decision).
 *
 * `request_id` ARRIVED IN CHAPTER 3.8, not in Part 2. The comment here promised
 * it "joins in Part 2, when a gateway exists to mint one"; Part 2 came and went,
 * the gateway existed, and the field did not. Constitution V asks for four fields
 * and the platform sent three for twenty-two chapters.
 *
 * REQUIRED, not optional, and that was a decision rather than an oversight. A
 * server-initiated frame is arguably not a response to a request, so optional
 * would have been defensible — and it would have been the fourth instance of the
 * habit this chapter is about: `rate_limited`, close code 4008 and this field
 * were all declared here and left unenforced. The gateway mints one per answered
 * frame instead (research R13). */
export const errorFrameSchema = z.strictObject({
  type: z.literal("error"),
  payload: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    docs_url: z.string().min(1),
    request_id: z.string().min(1),
    field: z.string().min(1).optional(),
  }),
});

/** Every frame either end may legally utter. */
export const frameSchema = z.discriminatedUnion("type", [
  connectionAckSchema,
  messageSendSchema,
  messageAckSchema,
  messageCreatedSchema,
  messageUpdatedSchema,
  messageDeletedSchema,
  membershipChangedSchema,
  presenceChangedSchema,
  typingSchema,
  typingSendSchema,
  errorFrameSchema,
]);

// The static types ARE the schemas — z.infer, never a hand-written twin.
export type Cursor = z.infer<typeof cursorSchema>;
export type Message = z.infer<typeof messageSchema>;
/** Chapter 3.23. The deleted frame's payload is the one that is NOT a `Message`, so it
 * needs a name of its own — otherwise every producer re-declares the shape inline and the
 * schema stops being the single statement of it. */
export type MessageDeleted = z.infer<typeof messageDeletedPayloadSchema>;
export type ConnectionAck = z.infer<typeof connectionAckSchema>;
export type MessageSend = z.infer<typeof messageSendSchema>;
export type MessageAck = z.infer<typeof messageAckSchema>;
export type Frame = z.infer<typeof frameSchema>;

/** Parse anything the wire delivers. Hostile input is an expected value, not
 * an exception: this returns zod's safeParse result and never throws. */
export function parseFrame(raw: unknown) {
  return frameSchema.safeParse(raw);
}
