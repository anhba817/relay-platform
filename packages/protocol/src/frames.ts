import { z } from "zod";

// The wire contract, one home (ADR-01). Every frame is a JSON object with a
// `type` discriminator and a `payload` (EIR-WS-02). Schemas are the single
// source of truth: every exported static type is inferred from its schema,
// so the types and the validation cannot drift — there is no second
// definition. Payloads are strict: unknown fields are rejected.

/** Per-channel resume cursor: { channel_id: highest seq seen } (ADR-03). */
export const cursorSchema = z.record(z.string(), z.number().int().positive());

/** The message on the wire — derived from the SAD §6.1 `messages` columns.
 * Wire spellings follow SAD §5.1's own frame line (`channel`, `seq`).
 * metadata/attachments/edit/tombstone fields arrive with Part 2/4. */
export const messageSchema = z.strictObject({
  id: z.string().min(1),
  channel: z.string().min(1),
  seq: z.number().int().positive(),
  user: z.string().min(1),
  text: z.string(),
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

export const messageDeletedSchema = z.strictObject({
  type: z.literal("message.deleted"),
  payload: messageSchema,
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
  errorFrameSchema,
]);

// The static types ARE the schemas — z.infer, never a hand-written twin.
export type Cursor = z.infer<typeof cursorSchema>;
export type Message = z.infer<typeof messageSchema>;
export type ConnectionAck = z.infer<typeof connectionAckSchema>;
export type MessageSend = z.infer<typeof messageSendSchema>;
export type MessageAck = z.infer<typeof messageAckSchema>;
export type Frame = z.infer<typeof frameSchema>;

/** Parse anything the wire delivers. Hostile input is an expected value, not
 * an exception: this returns zod's safeParse result and never throws. */
export function parseFrame(raw: unknown) {
  return frameSchema.safeParse(raw);
}
