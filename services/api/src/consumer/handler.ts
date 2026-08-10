import type { OutboxEvent } from "../outbox/event";

// What a handler is, and — more importantly — what it is not (chapter 3.4).
//
// SAD risk R5: "a future consumer forgets to dedupe → double webhooks / double
// metering", mitigated by a "consumer template with dedup built in". The way to
// make forgetting impossible is to leave a handler nothing to forget. It cannot
// acknowledge, cannot negatively acknowledge, cannot retry, cannot deduplicate,
// and cannot see the raw message. It can return, or it can throw.

export interface EventContext {
  /** The broker's delivery count for this message: 1 on the first attempt.
   * A handler may LOG it. It must not use it to decide correctness — a handler
   * that behaves differently on attempt three is a handler whose behaviour
   * depends on a timeout somewhere else. */
  attempt: number;
}

/** Returns → handled. Throws → not handled, try again. */
export type EventHandler = (
  event: OutboxEvent,
  context: EventContext,
) => Promise<void>;
