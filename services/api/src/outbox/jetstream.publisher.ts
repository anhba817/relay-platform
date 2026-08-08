import {
  connect,
  type JetStreamClient,
  type NatsConnection,
} from "nats";

import type { Publisher, PublishedMessage } from "./publisher";

// The one adapter that knows what a broker is (chapter 3.3, ADR-02).
//
// Everything upstream of this file speaks in subjects and payloads; swapping
// JetStream for something else means writing another file like this one and
// changing nothing that produces events. That is the reversibility ADR-06
// claims for the outbox, expressed as a module boundary rather than a promise.

export const DEFAULT_NATS_URL = "nats://localhost:4222";

/** One stream over `events.>`, file-backed. This is the MINIMUM a publisher
 * needs in order to be provable — publishing into a broker with no stream is
 * fire-and-forget, and the chapter's claim would be false at the last hop.
 *
 * The real design of the subject space — FR-WHK-02's full event-type list,
 * per-environment sharding, retention, replicas — belongs to chapter 3.4 along
 * with every consumer. */
const STREAM = "EVENTS";
const SUBJECTS = ["events.>"];

export function createJetStreamPublisher({
  url = process.env.RELAY_NATS_URL ?? DEFAULT_NATS_URL,
}: { url?: string } = {}): Publisher {
  let connection: NatsConnection | null = null;
  let js: JetStreamClient | null = null;

  /** Connection is LAZY and re-attempted. The api must start and accept writes
   * with the broker unreachable — a service that refuses to boot without its
   * event spine has made the spine a dependency of the write path, which is the
   * opposite of what an outbox is for (research R9). */
  async function client(): Promise<JetStreamClient> {
    if (js && connection && !connection.isClosed()) return js;
    const nc = await connect({ servers: url });
    const jsm = await nc.jetstreamManager();
    // Created if absent, left alone if present: two api instances starting
    // together must not fight over it.
    const existing = await jsm.streams
      .info(STREAM)
      .then(() => true)
      .catch(() => false);
    if (!existing) {
      await jsm.streams.add({ name: STREAM, subjects: [...SUBJECTS] });
    }
    connection = nc;
    js = nc.jetstream();
    return js;
  }

  return {
    async publish({ subject, id, payload }: PublishedMessage): Promise<void> {
      const stream = await client();
      // `msgID` is the broker's deduplication key, and it is the ENVELOPE's id
      // — so a republish after a crash is recognisable as the same event rather
      // than as a second one. JetStream will collapse it inside its dedupe
      // window; consumers must still deduplicate for the general case, which is
      // why the id is in the payload too (ADR-06's system-wide discipline).
      await stream.publish(subject, new TextEncoder().encode(JSON.stringify(payload)), {
        msgID: id,
      });
    },
    async close(): Promise<void> {
      if (connection && !connection.isClosed()) {
        await connection.drain();
      }
      connection = null;
      js = null;
    },
  };
}
