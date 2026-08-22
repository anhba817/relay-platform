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
  /** Chapter 3.8. The two limits the gateway enforces, resolved from the
   * environment's policy with nulls already turned into defaults.
   *
   * THEY RIDE THIS RESPONSE BECAUSE THE GATEWAY HAS NO DATABASE, and must not
   * gain one — `registry.ts` states that as a design property: "no pg, no
   * drizzle-orm, no repository import". The policy is three columns in Postgres
   * and the api is the only service that reads Postgres, so the limits travel on
   * the one call the gateway was already making at connect.
   *
   * The same move chapter 3.2 made on this call, whose comment records it: the
   * api "answers with the identity AND the memberships … it just asks a better
   * question than 'what may this user hear'". This asks it for one thing more
   * (research R12). */
  limits: z.strictObject({
    connect: z.number().int().nonnegative(),
    send: z.number().int().nonnegative(),
  }),
});

/** The deliveries stream (chapter 3.5), and its subject grammar.
 *
 * Here rather than in either service, for the reason chapter 3.4 moved the event
 * grammar here: a consumer that assembles its own subject filter receives
 * nothing the day the grammar changes — no error, no warning, just an empty
 * stream position. Two sides, one definition.
 *
 * The stream carries only work that is ALREADY DUE. A delivery waiting out a
 * retry tier is a row in Postgres, not a message the broker is holding — which
 * is what keeps a dead endpoint from occupying an acknowledgement slot for two
 * hours (research R1, measured). */
export const DELIVERIES_STREAM = "DELIVERIES";
export const DELIVERY_SUBJECT_PREFIX = "deliveries";
export const ALL_DELIVERIES_SUBJECT = `${DELIVERY_SUBJECT_PREFIX}.>`;

/** One subject per environment, so a future per-tenant dispatcher shard is a
 * filter change rather than a redesign. */
export function deliverySubjectFor(environmentId: string): string {
  if (!environmentId) throw new Error("an environment id is required");
  return `${DELIVERY_SUBJECT_PREFIX}.${environmentId}`;
}

// ---------------------------------------------------------------------------
// Analytical events (chapter 3.6, constitution III).
//
// The THIRD grammar in this file, and it is here for the reason the other two
// are: a consumer that assembles its own subject filter receives nothing the day
// the grammar changes — no error, no warning, just an empty stream position. Part
// 4's ingester is that consumer, and it does not exist yet, which is exactly when
// a shared definition is cheapest to establish.
//
// `analytics.{domain}.{action}.{environment_id}` extends chapter 3.4's
// `events.{domain}.{action}.{env}` rather than inventing a second convention.
//
// The stream is SEPARATE from `EVENTS` and `DELIVERIES`, and that is a decision
// rather than tidiness (research R4). `EVENTS` carries tenant domain events whose
// consumers must not miss one; `DELIVERIES` carries work. Attempt records are
// neither: high volume, deliberately lossy (research R5), and a consumer that
// wants them does not want every message event alongside.
// ---------------------------------------------------------------------------

export const ANALYTICS_STREAM = "ANALYTICS";
export const ANALYTICS_SUBJECT_PREFIX = "analytics";
export const ALL_ANALYTICS_SUBJECT = `${ANALYTICS_SUBJECT_PREFIX}.>`;

/** A UUID, checked rather than trusted.
 *
 * The environment id becomes a SUBJECT TOKEN, and NATS subjects are
 * dot-delimited: a value containing a dot silently creates a deeper subject than
 * intended, and one containing `*` or `>` creates a wildcard. Neither fails at
 * publish time. Both would put one tenant's attempt records where another
 * tenant's filter can reach them, which is constitution I stated as a parsing
 * problem. Every caller in this platform holds a uuid already, so refusing
 * anything else costs nothing. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function analyticsSubjectFor(
  domain: string,
  action: string,
  environmentId: string,
): string {
  if (!domain) throw new Error("a domain is required");
  if (!action) throw new Error("an action is required");
  if (!UUID.test(environmentId)) {
    throw new Error("an environment id must be a uuid");
  }
  return [ANALYTICS_SUBJECT_PREFIX, domain, action, environmentId].join(".");
}

/** The one action this chapter publishes. Named so a consumer filters on a
 * constant rather than on a string it typed. */
export const WEBHOOK_ATTEMPT_ACTION = { domain: "webhook", action: "attempt" };

export function webhookAttemptSubject(environmentId: string): string {
  return analyticsSubjectFor(
    WEBHOOK_ATTEMPT_ACTION.domain,
    WEBHOOK_ATTEMPT_ACTION.action,
    environmentId,
  );
}

// ---------------------------------------------------------------------------
// The dispatch contract (chapter 3.5, constitution IV).
//
// The dispatcher owns no database. "Only the API service writes to PostgreSQL…
// Other services obtain writes and backfill reads via the API service's internal
// endpoints." These are those endpoints, and they live here for the reason
// chapter 2.5 put the gateway's here: both sides validate against ONE definition,
// so the day a field is renamed the other side fails loudly instead of reading
// `undefined` three layers away.
// ---------------------------------------------------------------------------

/** dispatcher → api: turn one event into one delivery per matching endpoint.
 *
 * A CLAIMED write: the api reuses chapter 3.4's deduplication ledger, so an event
 * expanded twice would double every webhook it produced and cannot. The claim and
 * all N delivery rows commit in one transaction (research R2). */
export const internalExpandRequestSchema = z.strictObject({
  event_id: z.string().uuid(),
  environment_id: z.string().min(1),
  type: z.string().min(1),
  /** The envelope as it will be delivered, byte-identical to what 3.3 published.
   * The dispatcher does not author payloads; it moves them. */
  payload: z.unknown(),
});

export const internalExpandResponseSchema = z.strictObject({
  /** How many deliveries this event produced. Zero is normal and not an error:
   * no endpoint in that environment subscribes to this type. */
  created: z.number().int().nonnegative(),
  /** True when the ledger recognised the event as already expanded. The
   * dispatcher acknowledges either way — that is what makes a redelivery safe. */
  duplicate: z.boolean(),
});

/** dispatcher → api: everything needed to sign and post one delivery.
 *
 * The response carries DECRYPTED signing secrets, which is a real widening of
 * where a customer credential exists. Internal network only, never logged, held
 * for the signature and no longer (contracts/dispatcher.md). */
export const internalDeliveryMaterialSchema = z.strictObject({
  delivery_id: z.string().uuid(),
  endpoint_id: z.string().uuid(),
  environment_id: z.string().min(1),
  event_id: z.string().uuid(),
  url: z.string().url(),
  attempt: z.number().int().positive(),
  /** One or two: two during a 24-hour rotation window, so a recipient holding
   * either can verify (contracts/webhooks.md §Rotation). */
  secrets: z.array(z.string().min(1)).min(1).max(2),
  payload: z.unknown(),
});

/** dispatcher → api: what happened when we posted.
 *
 * NOT a claim — the POST already happened on somebody else's machine and cannot
 * be undone. Idempotent on `(delivery_id, attempt)`, so a redelivery arriving
 * after a successful report is recognised and simply acknowledged rather than
 * posted again (research R5). */
export const internalDeliveryOutcomeRequestSchema = z.strictObject({
  delivery_id: z.string().uuid(),
  attempt: z.number().int().positive(),
  /** Absent when the attempt never got a response — a timeout or a refused
   * connection. The platform can only believe a status code it received. */
  status: z.number().int().optional(),
  error: z.string().max(2000).optional(),
  latency_ms: z.number().int().nonnegative(),
});

export const internalDeliveryOutcomeResponseSchema = z.strictObject({
  /** What the api did with it: delivered, scheduled for another tier, or moved
   * to the dead-letter store because the attempts are exhausted. */
  outcome: z.enum(["delivered", "rescheduled", "dead_lettered"]),
  /** Present when rescheduled — when the next attempt falls due. */
  next_attempt_at: z.iso.datetime().optional(),
});

export type InternalExpandRequest = z.infer<typeof internalExpandRequestSchema>;
export type InternalExpandResponse = z.infer<
  typeof internalExpandResponseSchema
>;
export type InternalDeliveryMaterial = z.infer<
  typeof internalDeliveryMaterialSchema
>;
export type InternalDeliveryOutcomeRequest = z.infer<
  typeof internalDeliveryOutcomeRequestSchema
>;
export type InternalDeliveryOutcomeResponse = z.infer<
  typeof internalDeliveryOutcomeResponseSchema
>;

/** The usage report (chapter 3.11, FR-005).
 *
 * THE ONE CALL THE GATEWAY MAKES FOR ITSELF. Its other three —
 * `/internal/session`, `/internal/backfill`, `/internal/messages` — forward the
 * END USER's token, because each is a user's action taken through the socket.
 * A usage report is nobody's action: it is the gateway's claim about many
 * connections, across many environments, about time that has already passed. So
 * it presents a platform credential and names its environments in the body, the
 * way the dispatcher's routes do.
 *
 * `minutes` IS A TOTAL, NOT AN INCREMENT, and that single decision is why the
 * gateway needs no retry buffer. A lost report is repaired by the next one,
 * because the next one carries the same total plus whatever accrued since. A
 * report delivered twice credits `max(0, reported - credited) = 0`. Reports that
 * cannot be delivered are dropped rather than queued (research R3).
 *
 * ONE ENTRY PER CONNECTION PER PERIOD. A socket open across midnight on the
 * first of the month owes minutes to two periods and sends two entries, because
 * each period is credited independently (FR-009). */
export const internalUsageReportEntrySchema = z.strictObject({
  connection_id: z.string().uuid(),
  environment_id: z.string().uuid(),
  /** The first of a calendar month, UTC — `usage_periods`' key, not a date the
   * caller picked. Refined rather than merely typed, because a report that
   * named the 14th would create a period nothing reads. */
  period: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/, "period must be the first of a month"),
  minutes: z.number().int().nonnegative(),
});

export const internalUsageReportRequestSchema = z.strictObject({
  connections: z.array(internalUsageReportEntrySchema).min(1).max(5000),
});

/** `credited` is the sum of the deltas actually applied, so a replay answers
 * `{"credited": 0}` and a caller can see its retry changed nothing.
 *
 * One field, because there is nothing else the caller can act on. An earlier
 * draft of the contract carried a `refused` count beside it, which described
 * nothing: the only refusal in this design rejects the whole request. */
export const internalUsageReportResponseSchema = z.strictObject({
  credited: z.number().int().nonnegative(),
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
export type InternalUsageReportEntry = z.infer<
  typeof internalUsageReportEntrySchema
>;
export type InternalUsageReportRequest = z.infer<
  typeof internalUsageReportRequestSchema
>;
export type InternalUsageReportResponse = z.infer<
  typeof internalUsageReportResponseSchema
>;
