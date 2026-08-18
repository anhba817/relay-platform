import {
  connect,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type NatsConnection,
} from "nats";

import { ALL_ANALYTICS_SUBJECT, ANALYTICS_STREAM } from "@relay/protocol";

import type { Publisher, PublishedMessage } from "./publisher";

// The one adapter that knows what a broker is (chapter 3.3, ADR-02).
//
// Everything upstream of this file speaks in subjects and payloads; swapping
// JetStream for something else means writing another file like this one and
// changing nothing that produces events. That is the reversibility ADR-06
// claims for the outbox, expressed as a module boundary rather than a promise.

export const DEFAULT_NATS_URL = "nats://localhost:4222";

/** One stream over `events.>`, file-backed.
 *
 * Chapter 3.3 created this with a name, its subjects and file storage, and left
 * everything else at whatever NATS defaults to — which on a development broker
 * meant no age limit, no size limit, and a two-minute duplicate window nobody
 * had chosen. Chapter 3.4 makes every setting a decision (research R2).
 *
 * Two of them can never be changed again, and both happen to be right:
 * `retention` and `storage` are immutable on an existing stream (measured, R1).
 * Had 3.3 taken memory storage as a convenience, applying this configuration
 * would have meant deleting the stream and every event in it. */
const STREAM = "EVENTS";
const SUBJECTS = ["events.>"];

const SECOND_NS = 1_000_000_000;

/** NFR-REL-08 asks the queue to retain events for at least 24 hours so that a
 * consumer outage is absorbed. Seven days is chosen over the floor for a reason
 * the floor does not cover: an outage that starts on a Friday evening is not
 * noticed until Monday. The floor protects a process crash; this protects a
 * weekend. */
const MAX_AGE_NS = 7 * 24 * 60 * 60 * SECOND_NS;

/** The analytics stream's own bound (chapter 3.6). The same seven days as
 * `EVENTS`, for a different reason: there it absorbs a consumer outage without
 * losing a tenant's events, here it absorbs an ingester outage without letting
 * the stream become a database. Named separately so the two can diverge when
 * Part 4 has an opinion, rather than one changing the other by accident. */
const ANALYTICS_MAX_AGE_NS = 7 * 24 * 60 * 60 * SECOND_NS;

/** An unbounded stream is a full disk with extra steps. The bound turns that
 * into a number an operator can watch — and with `discard: old`, hitting it
 * loses the OLDEST events rather than refusing new publishes. Refusing
 * publishes would take the write path down with the event spine, which is the
 * inversion chapter 3.3's outbox exists to prevent. */
const MAX_BYTES = 1024 * 1024 * 1024;

/** ADR-02 specifies R3 replication. The compose stack is a single node, so this
 * is environment-derived rather than hardcoded to either value: a chapter that
 * wrote `3` would not run locally, and one that wrote `1` would ship a
 * single-replica event spine to production. */
function replicaCount(): number {
  const configured = Number(process.env.RELAY_NATS_REPLICAS ?? "");
  if (Number.isInteger(configured) && configured > 0) return configured;
  return process.env.NODE_ENV === "production" ? 3 : 1;
}

/** Apply the stream's configuration, whether or not it exists yet.
 *
 * Idempotent on purpose: two api instances starting together both run this, and
 * the second must be a no-op rather than an error. On an existing stream the
 * MUTABLE settings are merged onto whatever is there, and the immutable ones are
 * carried through untouched — attempting to change `retention` or `storage` is
 * an error the broker refuses rather than a difference it reconciles (R1).
 *
 * `duplicate_window` is deliberately left where 3.3 found it. Raising it looks
 * like the fix for a republished event and is not: the outbox can republish
 * hours after an outage, no window is a safe guess about the longest one, and a
 * window measured in hours would hold that dedupe index in the broker's memory
 * for hours. The guarantee belongs where the work happens — at the consumer
 * (research R3, SAD risk R5). */
export async function ensureStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  const mutable = {
    subjects: [...SUBJECTS],
    max_age: MAX_AGE_NS,
    max_bytes: MAX_BYTES,
    discard: DiscardPolicy.Old,
    num_replicas: replicaCount(),
  };
  const existing = await jsm.streams.info(STREAM).catch(() => null);
  if (existing === null) {
    await jsm.streams.add({
      name: STREAM,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      ...mutable,
    });
    return;
  }
  await jsm.streams.update(STREAM, { ...existing.config, ...mutable });
}

/** The ANALYTICS stream (chapter 3.6, constitution III).
 *
 * A THIRD stream rather than a third use of `EVENTS`, and the reasons are all
 * about the difference between an operational event and an analytical one
 * (research R4): different volume, different retention, and a Part 4 ingester
 * that should be able to consume attempt records without also consuming every
 * message event in the platform.
 *
 * Reuses the `ensure` parameter chapter 3.5 added rather than introducing a
 * second mechanism — the publisher already knows how to bring one stream into
 * existence, and "which stream" has been a parameter since a delivery published
 * to `deliveries.*` came back 503.
 *
 * SEVEN DAYS, `discard: old`, and no acknowledgement anywhere: nothing consumes
 * this stream in this chapter. Seven days is long enough for an ingester to be
 * down over a long weekend and short enough that the stream does not quietly
 * become the analytical database it is supposed to feed. At the bound the oldest
 * analytics is the least interesting, which is the one case where dropping the
 * old data is the right answer — the opposite choice on `EVENTS` would lose a
 * tenant's events, and there `discard: old` is a bound on a liability instead. */
export async function ensureAnalyticsStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  const mutable = {
    subjects: [ALL_ANALYTICS_SUBJECT],
    max_age: ANALYTICS_MAX_AGE_NS,
    max_bytes: MAX_BYTES,
    discard: DiscardPolicy.Old,
    num_replicas: replicaCount(),
  };
  const existing = await jsm.streams.info(ANALYTICS_STREAM).catch(() => null);
  if (existing === null) {
    await jsm.streams.add({
      name: ANALYTICS_STREAM,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      ...mutable,
    });
    return;
  }
  // Retention and storage are immutable on an existing stream — chapter 3.4
  // measured that (its research R1), and the lesson transfers unchanged.
  await jsm.streams.update(ANALYTICS_STREAM, { ...existing.config, ...mutable });
}

export function createJetStreamPublisher({
  url = process.env.RELAY_NATS_URL ?? DEFAULT_NATS_URL,
  ensure = ensureStream,
}: {
  url?: string;
  /** Which stream this publisher is responsible for bringing into existence.
   * Defaults to the EVENTS stream this chapter created. Chapter 3.5 passes its
   * own: a publisher that ensures the wrong stream publishes into nothing and
   * gets a 503 back, which is a confusing way to learn that streams are not
   * created on demand. */
  ensure?: (nc: NatsConnection) => Promise<void>;
} = {}): Publisher {
  let connection: NatsConnection | null = null;
  let js: JetStreamClient | null = null;

  /** Connection is LAZY and re-attempted. The api must start and accept writes
   * with the broker unreachable — a service that refuses to boot without its
   * event spine has made the spine a dependency of the write path, which is the
   * opposite of what an outbox is for (research R9). */
  async function client(): Promise<JetStreamClient> {
    if (js && connection && !connection.isClosed()) return js;
    const nc = await connect({ servers: url });
    await ensure(nc);
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
