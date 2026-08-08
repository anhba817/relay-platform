// The event envelope (chapter 3.3). Built in ONE place, complete, inside the
// transaction that caused it — so the relay is a mover of bytes and never an
// author of them (ADR-04, research R7).
//
// Nothing in this file reads the clock or generates an id. Both arrive from the
// caller, which is what makes a republished event byte-identical to its first
// attempt: the deduplication key a consumer sees after a crash is the same key
// it would have seen without one.

/** A message as the PUBLIC api returns it. Consumers are customers: they get
 * external ids and the field names the REST surface uses. `user_id` does not
 * cross this boundary. */
export interface MessageCreatedData {
  id: string;
  channel_id: string;
  seq: number;
  user: string | null;
  text: string | null;
  created_at: string;
}

export interface OutboxEvent {
  /** UUID, generated in the transaction. The consumer's deduplication key. */
  id: string;
  /** FR-WHK-02's name for this event, spelled as that requirement spells it. */
  type: "message.created";
  environment_id: string;
  /** When the state change happened — the message's own timestamp, not the
   * moment this object was constructed. */
  occurred_at: string;
  data: MessageCreatedData;
}

export interface PendingEvent {
  subject: string;
  payload: OutboxEvent;
}

/** `events.msg.created.{environment_id}` — the shape SAD §6.1's own comment
 * gives. The full subject taxonomy for FR-WHK-02's other seven types, and any
 * per-environment sharding, belongs to chapter 3.4. */
export function subjectFor(type: string, environmentId: string): string {
  const leaf = type.replace(/^message\./, "msg.");
  return `events.${leaf}.${environmentId}`;
}

export function messageCreatedEvent({
  eventId,
  environmentId,
  message,
}: {
  eventId: string;
  environmentId: string;
  message: MessageCreatedData;
}): PendingEvent {
  // Refused rather than defaulted. An event with no deduplication key looks
  // deliverable and cannot be deduplicated, which is worse than no event.
  if (!eventId) throw new Error("an event id is required");
  if (!environmentId) throw new Error("an environment id is required");

  return {
    subject: subjectFor("message.created", environmentId),
    payload: {
      id: eventId,
      type: "message.created",
      environment_id: environmentId,
      occurred_at: message.created_at,
      data: message,
    },
  };
}
