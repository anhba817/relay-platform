import { z } from "zod";

// The INTERNAL service contract (chapter 2.5) — distinct from the wire
// contract above it. `frames.ts` is what a customer's client speaks;
// this is what the gateway and the API service speak to each other over
// the internal HTTP hop (ADR-05).
//
// It lives in the same package for the same reason the frames do: two
// components on either side of a boundary, one definition between them.
// The gateway derives its client types from these schemas AND parses
// responses with them — an internal caller has no more right to assume a
// payload's shape than an external one does.

/** Gateway → api: forward the payload a `message.send` frame carried. */
export const internalSendRequestSchema = z.strictObject({
  channel_id: z.string().uuid(),
  text: z.string().min(1).max(8000), // FR-MSG-01
  idempotency_key: z.string().min(1).max(255).optional(), // FR-MSG-04
});

/** api → gateway: the committed message. `seq` is what the ack carries
 * (FR-MSG-05 — after the commit, never before). */
export const internalSendResponseSchema = z.strictObject({
  id: z.string().min(1),
  channel_id: z.string().min(1),
  seq: z.number().int().positive(),
  text: z.string().nullable(),
  created_at: z.iso.datetime(),
});

/** api → gateway: the channels this user may hear (FR-RTM-01). */
export const internalMembershipsResponseSchema = z.strictObject({
  channel_ids: z.array(z.string().min(1)),
});

export type InternalSendRequest = z.infer<typeof internalSendRequestSchema>;
export type InternalSendResponse = z.infer<typeof internalSendResponseSchema>;
export type InternalMembershipsResponse = z.infer<
  typeof internalMembershipsResponseSchema
>;
