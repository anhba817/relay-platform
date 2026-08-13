import type { Logger } from "@relay/service-kit";

import type { ApiClient } from "./api-client.js";

// Turning an event into deliveries (chapter 3.5).
//
// The dispatcher does not write the rows. It cannot — constitution IV reserves
// PostgreSQL writes to the API service — so it asks, and the api does the work
// inside chapter 3.4's claim transaction. What looks like an inconvenience is
// what makes the operation exactly-once: the claim and the N delivery rows
// commit together or not at all, so an event the broker redelivers cannot
// produce a second set of webhooks (research R2).

/** The envelope as chapter 3.3 publishes it. Parsed here rather than trusted,
 * for chapter 2.5's reason: a message that has been sitting in a stream has had
 * time to stop matching the code that reads it. */
export interface EventEnvelope {
  id: string;
  type: string;
  environment_id: string;
}

export function parseEventEnvelope(raw: unknown): EventEnvelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (
    typeof e["id"] !== "string" ||
    typeof e["type"] !== "string" ||
    typeof e["environment_id"] !== "string"
  ) {
    return null;
  }
  return {
    id: e["id"],
    type: e["type"],
    environment_id: e["environment_id"],
  };
}

export type ExpandOutcome = "expanded" | "duplicate" | "unparseable";

/** One event, expanded.
 *
 * `unparseable` is terminal and deliberately so — the same bytes fail the same
 * way every time, so retrying spends delivery attempts to reach a conclusion
 * that was available on the first. Chapter 3.4 made the same call for the same
 * reason. */
export async function expandOnce(
  api: ApiClient,
  logger: Logger,
  raw: unknown,
): Promise<ExpandOutcome> {
  const event = parseEventEnvelope(raw);
  if (!event) {
    logger.log("error", "expand.unparseable", {});
    return "unparseable";
  }

  const result = await api.expand({
    event_id: event.id,
    environment_id: event.environment_id,
    type: event.type,
    payload: raw,
  });

  // Identifiers and counts. `raw` is a tenant's event and never reaches a log
  // line (NFR-SEC-06).
  logger.log("info", "expand.done", {
    event_id: event.id,
    type: event.type,
    created: result.created,
    duplicate: result.duplicate,
  });

  return result.duplicate ? "duplicate" : "expanded";
}
