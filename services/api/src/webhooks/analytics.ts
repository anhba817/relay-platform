import { webhookAttemptSubject } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import type { Publisher } from "../outbox/publisher";

// The attempt record, on its way to the analytical path (chapter 3.6, FR-001,
// constitution III).
//
// This file is small and its whole subject is one decision, so the decision is
// written here rather than in the chapter alone: THE PUBLISH IS ALLOWED TO FAIL,
// and failing must cost the delivery nothing.
//
// Constitution III: "Analytical events are emitted asynchronously — never
// synchronously on the request path. Failure or backlog of the analytical
// pipeline MUST NOT affect message delivery, API availability, or webhook
// dispatch." FR-WHK-06 says every delivery attempt shall be recorded. Those two
// cannot both be maximised, and research R5 chose which one wins:
//
//   * record every attempt without loss → the record shares a transaction with
//     the outcome (3.3's outbox), and then a stalled analytics consumer backs up
//     an operational table;
//   * guarantee independence → the publish happens after the commit, outside it,
//     and a crash in that gap loses the record.
//
// Independence wins, because the two costs are not equal. A lost attempt record
// is a gap in a dashboard. A blocked outcome transaction is a customer's webhooks
// stopping because a metering pipeline is unwell — which constitution III names
// as a design failure in as many words.
//
// So "every attempt" is APPROXIMATE, and the chapter says so in the paragraph
// that introduces the feature rather than in a footnote.

/** The publisher that reaches the ANALYTICS stream, as a DI token.
 *
 * A SECOND publisher rather than a second use of the first. Each
 * `createJetStreamPublisher` ensures exactly one stream, and chapter 3.5 already
 * learned what happens when a publisher is pointed at a stream it did not create:
 * every publish comes back 503, which is a confusing way to discover that
 * JetStream does not create streams on demand. Declared here, beside the function
 * that uses it, so the module wiring reads as configuration rather than as
 * knowledge. */
export const ANALYTICS_PUBLISHER = Symbol("ANALYTICS_PUBLISHER");

/** What one attempt looked like. Assembled by the caller from the outcome it has
 * just recorded, because the api is the only party holding all of it: the
 * dispatcher has the status and the latency but not the environment, and nothing
 * but the api knows what the outcome WAS. */
export interface AttemptRecord {
  deliveryId: string;
  endpointId: string;
  environmentId: string;
  eventId: string;
  attempt: number;
  /** Absent when nothing answered. A timeout has no status, and inventing one —
   * 0, 599 — would make every dashboard built on this lie in the same direction. */
  status?: number;
  /** Present when there was no status. Already capped at 2000 characters by the
   * seam's schema, so nothing is truncated here. */
  error?: string;
  latencyMs: number;
  outcome: "delivered" | "rescheduled" | "dead_lettered";
  attemptedAt: Date;
}

/** The wire shape, in `contracts/attempts.md`. Snake case because it leaves the
 * platform: a consumer written in another language reads this, and Part 4's
 * ingester is the first of them. */
interface AttemptEvent {
  delivery_id: string;
  endpoint_id: string;
  environment_id: string;
  event_id: string;
  attempt: number;
  attempted_at: string;
  status?: number;
  error?: string;
  latency_ms: number;
  outcome: string;
}

/** IDENTIFIERS, STATUSES AND DURATIONS ONLY (FR-004, NFR-SEC-06).
 *
 * The record is built by naming every field rather than by spreading the input,
 * and that is the point. A spread would carry whatever a future caller happened
 * to put on the record — a payload, a decrypted secret, a header — onto a stream
 * with seven-day retention that nothing in this platform reads yet. An allow-list
 * fails closed when somebody adds a field; a spread fails open. */
function shape(record: AttemptRecord): AttemptEvent {
  return {
    delivery_id: record.deliveryId,
    endpoint_id: record.endpointId,
    environment_id: record.environmentId,
    event_id: record.eventId,
    attempt: record.attempt,
    attempted_at: record.attemptedAt.toISOString(),
    // `exactOptionalPropertyTypes` is on, so these are spread in rather than
    // assigned: an explicit `undefined` is not the same as an absent key, and the
    // difference is the whole meaning of "nothing answered".
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    latency_ms: record.latencyMs,
    outcome: record.outcome,
  };
}

/** Publish one attempt record. Never throws.
 *
 * Call this AFTER the outcome transaction has committed, never inside it. Inside,
 * a broker that is slow makes an operational transaction slow and holds a row
 * lock while it waits, which is the coupling this whole design exists to avoid —
 * and the sabotage battery moves this call inside the transaction to prove the
 * suite would notice.
 *
 * The failure is swallowed HERE rather than at each call site, so no caller can
 * accidentally turn an analytics outage into a delivery outage by forgetting a
 * `catch`. A caller that wanted to know would have to ask, and none does. */
export async function publishAttempt(
  publisher: Publisher,
  logger: Logger,
  record: AttemptRecord,
): Promise<void> {
  try {
    await publisher.publish({
      subject: webhookAttemptSubject(record.environmentId),
      // The broker's deduplication key, and it is `{delivery}:{attempt}` for the
      // reason chapter 3.5 learned the hard way: the delivery id alone is stable
      // across all seven attempts, and using it collapsed every retry into the
      // first attempt's message. That bug cost the platform its entire retry
      // schedule and was found by a walk rather than by a test. Here the same
      // mistake would silently discard attempts 2 through 7 from every dashboard.
      id: `${record.deliveryId}:${record.attempt}`,
      payload: shape(record),
    });
  } catch (error) {
    // One line, no payload, no secret — and no rethrow. The delivery already
    // happened and the outcome is already committed; there is nothing this
    // failure can usefully undo, and plenty it could break by trying.
    logger.log("error", "analytics.attempt_publish_failed", {
      delivery_id: record.deliveryId,
      attempt: record.attempt,
      error: String(error),
    });
  }
}
