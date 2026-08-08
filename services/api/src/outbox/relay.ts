import type { Logger } from "@relay/service-kit";

import type { Db } from "../db/client";
import { drainOutbox } from "../db/repository";
import { publishPending, type Publisher } from "./publisher";

// The relay (chapter 3.3, ADR-06): the loop that moves committed events to the
// broker. It owns no state of its own — its entire progress is visible in the
// table it drains, which is what makes "promotable to its own deployment" true
// rather than aspirational.
//
// It is NOT on the request path. A write commits its event and returns; whether
// the broker is reachable is this loop's problem and nobody else's (research
// R9). That inversion is the whole point of an outbox.

/** Rows per pass. Small enough that a failing publisher costs one short
 * transaction rather than a long one; large enough that a backlog drains in
 * sensible steps. A batch is a transaction, and long transactions hold locks. */
const BATCH_SIZE = 100;

/** Wake-ups per second when idle. FR-ANL-04 allows 60 seconds for an event to
 * become queryable and this budget has two orders of magnitude of headroom, so
 * the interval is chosen for tidiness rather than for latency: a poll every
 * 200ms is invisible to Postgres and keeps the demonstration snappy. If this
 * ever needs to be lower, `LISTEN`/`NOTIFY` is the answer — and the poll still
 * has to exist underneath it as the correctness path (research R2). */
const IDLE_INTERVAL_MS = 200;

export interface Relay {
  /** Runs until `stop()`. Never rejects: a broker that is down is an expected
   * state, not a crash. */
  start(): void;
  stop(): Promise<void>;
  /** One pass, for tests and for the walk script — the same code path `start`
   * runs, so nothing is proven about a loop that only tests exercise. */
  drainOnce(): Promise<number>;
}

export function createRelay({
  db,
  publisher,
  logger,
  batchSize = BATCH_SIZE,
  intervalMs = IDLE_INTERVAL_MS,
}: {
  db: Db;
  publisher: Publisher;
  logger: Logger;
  batchSize?: number;
  intervalMs?: number;
}): Relay {
  let running = false;
  let loop: Promise<void> = Promise.resolve();

  async function drainOnce(): Promise<number> {
    return drainOutbox(db, batchSize, async (row) => {
      await publishPending(publisher, {
        subject: row.subject,
        payload: row.payload as { id: string },
      });
    });
  }

  async function run(): Promise<void> {
    while (running) {
      try {
        const published = await drainOnce();
        if (published > 0) {
          // Counts and durations, never payloads. A message body in a log line
          // is a tenant's data in an operator's terminal (NFR-SEC-06).
          logger.log("info", "outbox.published", { count: published });
          continue; // straight back for more; a backlog should not wait
        }
      } catch (error) {
        // The broker being unreachable lands here, and it is not an error the
        // relay can do anything about except try again. Rows stay pending,
        // which is exactly the buffering SAD §7 promises.
        logger.log("error", "outbox.drain_failed", { error: String(error) });
      }
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
      await publisher.close();
    },
    drainOnce,
  };
}
