import type { Logger } from "@relay/service-kit";

import type { EventHandler } from "./handler";

// The first consumer (chapter 3.4) — and it is a SCAFFOLD, with a named
// retirement, not a feature.
//
// Every consumer the SAD names belongs to a later chapter: the webhook
// dispatcher (3.5), the analytics ingester and the media worker (Part 4), the
// dashboard's live stream (Part 5). Giving this one a job would mean either
// stealing 3.5's subject or inventing product nobody asked for, and Principle
// VII forbids the second.
//
// So it does the smallest real thing: it observes that an event arrived. The
// EFFECT — the row in `consumed_events` — is written by the runtime's claim, in
// the same transaction, which is the entire mechanism this chapter exists to
// demonstrate. This handler's body is nearly empty on purpose, and that
// emptiness is the point: what makes the consumer correct is the runtime around
// it, not the code inside it.
//
// RETIREMENT: chapter 3.5 replaces this with the webhook dispatcher, which is a
// handler with the same signature and a great deal more to do.
export function createRecorder(logger: Logger): EventHandler {
  return async (event, context) => {
    // Identifiers and counts only — never `event.data.text`. A tenant's message
    // body has no business in the platform's own logs (NFR-SEC-06).
    logger.log("info", "event.recorded", {
      event_id: event.id,
      type: event.type,
      environment_id: event.environment_id,
      attempt: context.attempt,
    });
  };
}
