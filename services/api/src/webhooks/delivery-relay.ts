import {
  ALL_DELIVERIES_SUBJECT,
  DELIVERIES_STREAM,
  deliverySubjectFor,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
import {
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type NatsConnection,
} from "nats";

import type { Db } from "../db/client";
import {
  drainDueDeliveries,
  sweepDisabledEndpoints,
  type DueDeliveryRow,
} from "../db/repository";
import type { Publisher } from "../outbox/publisher";

// The second relay (chapter 3.5, research R13).
//
// This is the moment chapter 3.3's outbox stops being a thing that moves EVENTS
// and becomes a shape: `SELECT … FOR UPDATE SKIP LOCKED`, publish, mark, for any
// work the platform owes itself and must not lose. The second instance is what
// makes it a pattern rather than a trick, and the reader has already built it.
//
// The one difference from 3.3's relay is a predicate — `next_attempt_at <=
// now()` — and that predicate IS the retry schedule. Nothing waits in the
// broker; a delivery enters the stream only once it is already due (research R1,
// measured).

/** One delivery, as it reaches the dispatcher, is deliberately thin: the id and
 * the attempt, and nothing else. The dispatcher fetches the URL, the payload and
 * the signing secrets over the internal seam when it is ready to send, so a
 * customer credential never sits in a broker (contracts/dispatcher.md).
 *
 * The subject grammar lives in `@relay/protocol` — 3.4's lesson, applied again:
 * two sides, one definition, or a consumer silently receives nothing. */

/** The api creates this stream because the api publishes to it. A publisher
 * whose stream does not exist gets a 503 back from the broker, which is a
 * confusing way to discover that JetStream does not create streams on demand.
 *
 * Its age bound is sized for "how long may the DISPATCHER be down", not "how
 * long is the longest retry tier" — because nothing waits here. Conflating those
 * two numbers is how the first design went wrong (research R1). */
const DELIVERIES_MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
const DELIVERIES_MAX_BYTES = 1024 * 1024 * 1024;

export async function ensureDeliveriesStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  const mutable = {
    subjects: [ALL_DELIVERIES_SUBJECT],
    max_age: DELIVERIES_MAX_AGE_NS,
    max_bytes: DELIVERIES_MAX_BYTES,
    discard: DiscardPolicy.Old,
  };
  const existing = await jsm.streams.info(DELIVERIES_STREAM).catch(() => null);
  if (existing === null) {
    await jsm.streams.add({
      name: DELIVERIES_STREAM,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      ...mutable,
    });
    return;
  }
  // Retention and storage are immutable on an existing stream — chapter 3.4
  // measured that (its research R1), and the lesson transfers unchanged.
  await jsm.streams.update(DELIVERIES_STREAM, { ...existing.config, ...mutable });
}

/** Small, for 3.3's reason: a batch is held inside one transaction, and a long
 * one holds row locks while it publishes. */
const BATCH_SIZE = 50;

/** The poll interval when there is nothing due. Deliveries become due on a clock
 * rather than on an insert, so unlike 3.3's relay there is no "wake me on write"
 * shortcut to be tempted by — a timer is the correctness path here, not a
 * fallback behind one. */
const IDLE_INTERVAL_MS = 250;

export interface DeliveryRelay {
  start(): void;
  stop(): Promise<void>;
  /** One pass, for tests and for the walk script — the same code path `start`
   * runs, so nothing is proven about a loop only tests exercise. */
  drainOnce(): Promise<number>;
  /** One sweep, same argument. Returns how many endpoints it disabled. */
  sweepOnce(): Promise<number>;
}

export function createDeliveryRelay({
  db,
  publisher,
  logger,
  batchSize = BATCH_SIZE,
  intervalMs = IDLE_INTERVAL_MS,
  sweepEnabled = process.env["RELAY_DISABLE_SWEEP"] !== "off",
}: {
  db: Db;
  publisher: Publisher;
  logger: Logger;
  batchSize?: number;
  intervalMs?: number;
  /** `RELAY_DISABLE_SWEEP=off` turns the second trigger off, and it exists for one
   * purpose: quickstart V6 asks a reader to watch a quiet endpoint stay enabled
   * and failing with the sweep off, and then be disabled with it on. The first
   * half is what an outcome-only check ships, and reading it is the only way the
   * second half means anything.
   *
   * DEFAULT ON. A flag whose default disabled a requirement would be a
   * requirement nobody had built. */
  sweepEnabled?: boolean;
}): DeliveryRelay {
  let running = false;
  let loop: Promise<void> = Promise.resolve();

  async function drainOnce(): Promise<number> {
    return drainDueDeliveries(db, batchSize, async (row: DueDeliveryRow) => {
      // The same three-field port chapter 3.3 defined, unchanged. That the
      // second relay needed no new seam is the evidence that 3.3's abstraction
      // was drawn in the right place.
      await publisher.publish({
        subject: deliverySubjectFor(row.environment_id),
        // The deduplication key is the delivery id AND THE ATTEMPT, and the
        // second half was missing until a walk against a failing endpoint went
        // looking for attempt 2 and found nothing had been sent.
        //
        // `row.id` alone is stable across all seven attempts, so every retry
        // republished under the key the first attempt had already used and
        // JetStream collapsed it inside the duplicate window. The publish
        // reported success, no message reached the dispatcher, and the row kept
        // the `dispatched_at` its claim had set — which only an outcome report
        // clears, and no outcome was ever coming. Every failing delivery stopped
        // dead after one attempt and the retry schedule below it never ran.
        //
        // Per attempt, a republish after a crash is still recognisably the same
        // work, which is what the deduplication is for. A NEW attempt is
        // genuinely new work and has to be allowed to say so.
        id: `${row.id}:${row.attempt}`,
        payload: {
          delivery_id: row.id,
          endpoint_id: row.endpoint_id,
          event_id: row.event_id,
          attempt: row.attempt,
        },
      });
    });
  }

  /** The auto-disable sweep, riding this loop (chapter 3.6, research R1).
   *
   * Here rather than in a scheduler of its own because this worker is already
   * awake, already owns a database connection, and already runs in the one service
   * permitted to write (constitution VII, constitution IV). A third background
   * process would be a third thing to deploy, monitor and reason about, for one
   * statement.
   *
   * Its failure is logged and dropped for the same reason the drain's is: an
   * endpoint that should have been disabled and was not is a cost measured in one
   * more failed delivery, while a relay that stops draining is a cost measured in
   * every customer's webhooks. */
  async function sweepOnce(): Promise<number> {
    if (!sweepEnabled) return 0;
    try {
      // The batch the default used to supply, now said out loud (feature 030).
      const disabled = await sweepDisabledEndpoints(db, 100);
      if (disabled > 0) {
        // A COUNT, and only when it is not zero. This runs several times a second
        // when the platform is idle, and a line per pass would bury every other
        // line in the service.
        logger.log("info", "webhooks.endpoints_disabled", { count: disabled });
      }
      return disabled;
    } catch (error) {
      logger.log("error", "webhooks.disable_sweep_failed", { error: String(error) });
      return 0;
    }
  }

  async function run(): Promise<void> {
    while (running) {
      try {
        const dispatched = await drainOnce();
        if (dispatched > 0) {
          // Counts, never payloads — and never a signing secret, which is why
          // this relay publishes ids rather than material (NFR-SEC-06).
          logger.log("info", "deliveries.dispatched", { count: dispatched });
          continue; // straight back for more; a backlog should not wait out the idle interval
        }
      } catch (error) {
        // A broker that is down is an expected state, not a crash. Rows stay
        // pending and due, so the backlog drains when it returns — the same
        // buffering 3.3's relay promises for events.
        logger.log("error", "deliveries.drain_failed", { error: String(error) });
      }
      // AFTER the drain and only when there was nothing due, so a backlog is never
      // made to wait behind a housekeeping query. An endpoint that has been failing
      // for an hour can wait another quarter of a second; a customer's webhook
      // cannot.
      await sweepOnce();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop = run();
    },
    async stop() {
      running = false;
      await loop;
    },
    drainOnce,
    sweepOnce,
  };
}
