import { z } from "zod";

import { messageSchema } from "./frames.js";

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
  /** The sender, as the api RECORDED it — not as the caller asserted it.
   * Added in chapter 2.6: fan-out is the first feature that must name a
   * sender, and a frame the live path invents would not match the frame
   * 2.7's resume path reads back out of Postgres. */
  user: z.string().min(1),
  text: z.string().nullable(),
  created_at: z.iso.datetime(),
  /** True when 2.3's idempotency index recognised a retry. The PUBLIC api
   * still hides this (a client cannot tell a retry from a first send);
   * an internal caller needs it, because storage being idempotent does
   * not make delivery idempotent — chapter 2.6's trap. */
  duplicate: z.boolean().optional(),
});

/** The per-connect channel ceiling (chapter 2.7). */
export const MAX_RESUME_CHANNELS = 200;

/** FR-RTM-04's ceiling: past this, the client is told to page history
 * instead of having the backlog streamed at it. */
export const BACKFILL_LIMIT = 500;

/** Gateway → api: resume cursors, `{channel_id: highest seq the client
 * applied}` (chapter 2.7, FR-RTM-03). A read with a body, so POST — the
 * cursor map does not belong in a URL.
 *
 * The map is SIZE-CAPPED. The gateway already drops cursors for channels
 * the caller is not a member of, so a well-behaved request is bounded by
 * membership; the cap is what stops a malformed or hostile one from
 * turning one connect into ten thousand index scans. */
export const internalBackfillRequestSchema = z.strictObject({
  cursors: z
    .record(z.string().min(1), z.number().int().nonnegative())
    .refine((map) => Object.keys(map).length <= MAX_RESUME_CHANNELS, {
      message: `at most ${MAX_RESUME_CHANNELS} channels per resume`,
    }),
});

/** api → gateway: per channel, everything after the cursor — as WIRE
 * frames, not as rows. The resume path must emit what the live path
 * emits, so the api hands back `messageSchema` payloads and the gateway
 * forwards them untouched; a frame that differs by one field between
 * "delivered live" and "delivered on resume" is a client bug waiting for
 * a reconnect to happen.
 *
 * `truncated` is per channel, because the ceiling is per channel: one
 * flooded channel must not force the others onto the history endpoint. */
export const internalBackfillResponseSchema = z.strictObject({
  channels: z.record(
    z.string().min(1),
    z.strictObject({
      messages: z.array(messageSchema),
      truncated: z.boolean(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Event subjects (chapter 3.4, ADR-02).
//
// The grammar is `events.{domain}.{action}.{env}` — ADR-02's, verbatim. It lived
// inside the api's outbox module in 3.3 because nothing else needed it. A
// consumer needs it now, and the package whose whole job is the shapes both
// sides share is where a shape shared by both sides belongs (1.3's premise).
//
// Built here and nowhere else. A consumer that filters on a subject it
// assembled itself is a consumer that silently receives nothing the day the
// grammar changes — no error, no warning, just an empty stream position.
// ---------------------------------------------------------------------------

/** Every subject the platform publishes on, and the wildcard that reads them
 * all. One entry today; FR-WHK-02 names seven more, each arriving with the
 * feature that can produce it. */
export const EVENT_SUBJECT_PREFIX = "events";
export const ALL_EVENTS_SUBJECT = `${EVENT_SUBJECT_PREFIX}.>`;

/** `message.created` → `msg.created`: the domain abbreviation ADR-02's example
 * uses (`events.msg.created.{env}`). Kept as a mapping rather than a string
 * operation so that a type whose subject form is NOT its dotted name has an
 * obvious place to be added. */
const DOMAIN_ABBREVIATION: Record<string, string> = {
  message: "msg",
};

export function subjectFor(type: string, environmentId: string): string {
  if (!type) throw new Error("an event type is required");
  if (!environmentId) throw new Error("an environment id is required");
  const [domain, ...rest] = type.split(".");
  const abbreviated = DOMAIN_ABBREVIATION[domain!] ?? domain!;
  return [EVENT_SUBJECT_PREFIX, abbreviated, ...rest, environmentId].join(".");
}

/** api → gateway: the channels this user may hear (FR-RTM-01). */
export const internalMembershipsResponseSchema = z.strictObject({
  channel_ids: z.array(z.string().min(1)),
});

/** api → gateway, chapter 3.2: who the presented token belongs to, and what it
 * may hear — in ONE answer.
 *
 * This replaces the memberships response above rather than joining it. The
 * gateway used to verify a token itself and then ask "what may this user hear";
 * it now presents the token and is told both. The round-trip count at connect is
 * unchanged, and the gateway stops being the thing that decides identity
 * (research R1).
 *
 * `user` is the EXTERNAL id, as everywhere else on this contract: internal uuids
 * are the api's business. */
export const internalSessionResponseSchema = z.strictObject({
  environment_id: z.string().min(1),
  user: z.string().min(1),
  channel_ids: z.array(z.string().min(1)),
});

export type InternalSendRequest = z.infer<typeof internalSendRequestSchema>;
export type InternalSessionResponse = z.infer<
  typeof internalSessionResponseSchema
>;
export type InternalSendResponse = z.infer<typeof internalSendResponseSchema>;
export type InternalMembershipsResponse = z.infer<
  typeof internalMembershipsResponseSchema
>;
export type InternalBackfillRequest = z.infer<
  typeof internalBackfillRequestSchema
>;
export type InternalBackfillResponse = z.infer<
  typeof internalBackfillResponseSchema
>;
