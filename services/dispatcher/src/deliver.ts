import type { Logger } from "@relay/service-kit";

import type { ApiClient } from "./api-client.js";
import { signatureHeaders } from "./signature.js";

// Posting to a machine the platform does not own (chapter 3.5).
//
// THE ORDER IS THE ARGUMENT: post, then report, then acknowledge.
//
// Chapter 3.4's consumer claimed the event and ran its effect in ONE
// transaction, so a crash between them rolled both back. Nothing here can do
// that. The effect is an HTTP request that has already happened on somebody
// else's machine, and the claim would be a call to another service. They cannot
// share a transaction and no arrangement of them can be made atomic.
//
// So the pattern does not degrade — it stops applying, and what replaces it is a
// choice about which way to be wrong:
//
//   claim BEFORE posting  → a crash in the gap loses the webhook silently. The
//                           customer never receives it and nobody can tell.
//   post BEFORE reporting → a crash in the gap re-posts on redelivery. The
//                           customer receives it twice and CAN tell, because the
//                           envelope carries the event id they deduplicate on.
//
// The platform takes the duplicate. A loss nobody can detect is worse than a
// duplicate the recipient was handed the means to absorb — and chapter 3.3 spent
// itself removing exactly the first kind of failure, so reintroducing it at the
// last hop would undo that work where a customer would feel it.

/** Long enough for a slow-but-working customer, short enough that a hanging one
 * cannot hold a worker while six tiers of schedule wait behind it. Stated as a
 * decision because both directions cost something: too short fails a customer
 * who is merely slow, too long lets one endpoint occupy capacity that belongs to
 * everyone else (research R7). */
export const ATTEMPT_TIMEOUT_MS = 10_000;

export interface DeliveryJob {
  delivery_id: string;
  endpoint_id: string;
  event_id: string;
  attempt: number;
}

export interface DeliveryResult {
  /** What the api decided: delivered, rescheduled onto the next tier, or
   * dead-lettered because the attempts are exhausted. `skipped` means the
   * delivery was no longer deliverable — its endpoint was paused or removed. */
  outcome: "delivered" | "rescheduled" | "dead_lettered" | "skipped";
}

/** One attempt, end to end.
 *
 * Never throws for a customer's failure: a 500, a timeout and a refused
 * connection are all normal inputs to a retry system. It throws only when the
 * API SERVICE cannot be reached, because that is the one failure the dispatcher
 * must not absorb — the delivery is still due, and the caller must leave the
 * message unacknowledged so the work comes back. */
export async function deliverOnce(
  api: ApiClient,
  logger: Logger,
  job: DeliveryJob,
  timeoutMs: number = ATTEMPT_TIMEOUT_MS,
): Promise<DeliveryResult> {
  const material = await api.material(job.delivery_id);
  if (!material) {
    // The endpoint was paused or removed after this delivery was scheduled. The
    // spec's edge case: events already in the retry schedule for a removed
    // endpoint must not be delivered, and must not accumulate forever.
    logger.log("info", "delivery.skipped", {
      delivery_id: job.delivery_id,
      reason: "endpoint_unavailable",
    });
    return { outcome: "skipped" };
  }

  // Signed over the EXACT bytes that will be transmitted. Serialising once and
  // reusing the string is not an optimisation — signing one rendering and
  // sending another is the re-serialisation trap, pointed at ourselves.
  const rawBody = JSON.stringify(material.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const started = Date.now();
  let status: number | undefined;
  let error: string | undefined;

  try {
    const response = await fetch(material.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signatureHeaders({ rawBody, timestamp, secrets: material.secrets }),
      },
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
  } catch (cause) {
    // A timeout or a refused connection. The platform can only believe a status
    // code it received, and it received none — so this is a failure, however the
    // request may have ended on the customer's side.
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const latencyMs = Date.now() - started;

  // Counts, identifiers and durations. Never the payload, never a signature, and
  // never `material.secrets` — this is the log line that would leak a customer's
  // credential if anyone widened it "just for debugging" (NFR-SEC-06).
  logger.log("info", "delivery.attempted", {
    delivery_id: job.delivery_id,
    endpoint_id: job.endpoint_id,
    event_id: job.event_id,
    attempt: material.attempt,
    status: status ?? null,
    latency_ms: latencyMs,
  });

  // THE GAP. A crash between the POST above and the report below means this
  // delivery is redelivered and posted again. That duplicate is the accepted
  // failure, and the customer absorbs it on the event id.
  const reported = await api.reportOutcome({
    delivery_id: job.delivery_id,
    attempt: material.attempt,
    ...(status !== undefined ? { status } : {}),
    ...(error !== undefined ? { error } : {}),
    latency_ms: latencyMs,
  });

  return { outcome: reported.outcome };
}
