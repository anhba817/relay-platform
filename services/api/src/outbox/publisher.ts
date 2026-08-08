// The port (chapter 3.3). ADR-06's quieter payoff is that the outbox is "the
// abstraction seam that makes ADR-02 reversible": every event originates in a
// Postgres table with a subject and a payload, and *which broker* is a relay
// configuration detail. That sentence is only true if the seam exists in the
// code, so here it is — three fields, none of them broker-specific.

export interface PublishedMessage {
  /** Where it goes. */
  subject: string;
  /** Which event this is — the envelope's own id, used as the broker's
   * deduplication key. Not the outbox row's number: that is a cursor into this
   * database and means nothing outside it (research R7). */
  id: string;
  /** What a consumer receives, already complete. */
  payload: unknown;
}

export interface Publisher {
  /** Resolves only when the destination has ACCEPTED the message. A publisher
   * that resolves early turns at-least-once into at-most-once, because the
   * relay marks a row published on this promise (research R3). */
  publish(message: PublishedMessage): Promise<void>;
  close(): Promise<void>;
}

/** Publish one row's worth of event. Trivial by design: the interesting parts
 * are the transaction that wrote the row and the relay that decides when to
 * mark it, and neither of them should have to know a broker's vocabulary. */
export async function publishPending(
  publisher: Publisher,
  pending: { subject: string; payload: { id: string } },
): Promise<void> {
  await publisher.publish({
    subject: pending.subject,
    id: pending.payload.id,
    payload: pending.payload,
  });
}
