import {
  AckPolicy,
  connect,
  DeliverPolicy,
  type JsMsg,
  type NatsConnection,
} from "nats";
import { ALL_EVENTS_SUBJECT } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import { createDb, createPool, type Db } from "../db/client";
import { claimEvent, type ClaimResult } from "../db/repository";
import { outboxEventSchema, type OutboxEvent } from "../outbox/event";
import { DEFAULT_NATS_URL, ensureStream } from "../outbox/jetstream.publisher";
import type { EventHandler } from "./handler";

// The consumer runtime (chapter 3.4). Fetch, decide, acknowledge — and
// deduplicate, so that a handler cannot forget to.
//
// SAD risk R5 is the whole reason this file exists rather than a page of
// instructions: "a future consumer forgets to dedupe → double webhooks / double
// metering", mitigated by a "consumer template with dedup built in". Built in
// means a handler is given no way to skip it.

const STREAM = "EVENTS";

/** Batch size per fetch. Small enough that a slow handler does not hold an
 * acknowledgement deadline over a hundred messages; large enough that a backlog
 * of twelve thousand drains in sensible steps rather than one round trip each. */
const BATCH = 25;

/** How long the broker waits for an acknowledgement before redelivering. Long
 * enough for a real handler, short enough that a killed instance's work comes
 * back promptly — which is also what makes the redelivery test tolerable to run
 * (research R7). */
const ACK_WAIT_NS = 30 * 1_000_000_000;

/** Bounded, because forever is not a retry policy. After this many attempts the
 * broker stops delivering and the message leaves the consumer's view entirely —
 * measured, not assumed (research R4). Nothing catches it. A dead-letter store
 * is FR-WHK-04's, in chapter 3.5. */
const MAX_DELIVER = 5;

/** Back-pressure: the broker stops handing out work when this much is
 * outstanding, so a stalled consumer cannot accumulate an unbounded pile of
 * unacknowledged messages. */
const MAX_ACK_PENDING = 100;

/** What the runtime does with a message. Extracted from the loop so the decision
 * table can be read in one place — and tested without a broker. */
export type Outcome = "acknowledge" | "retry" | "terminate";

/** The decision, given a parsed payload and a way to claim it.
 *
 * `claim` receives the effect to run and reports whether this call won the
 * ledger row. It is passed in rather than called directly so this function has
 * no database of its own to reason about.
 */
export async function decideOutcome({
  parsed,
  attempt = 1,
  claim,
  handler,
}: {
  parsed: OutboxEvent | null;
  attempt?: number;
  claim: (effect: () => Promise<void>) => Promise<ClaimResult>;
  handler?: EventHandler;
}): Promise<Outcome> {
  // A payload that will never parse must not consume five delivery attempts
  // before being dropped anyway. The same bytes fail the same way every time.
  if (parsed === null) return "terminate";

  try {
    const result = await claim(async () => {
      await handler?.(parsed, { attempt });
    });
    // "duplicate" means somebody already handled this — including a previous
    // delivery to this same consumer that crashed after committing. The message
    // is acknowledged because it genuinely has been handled, just not now.
    return result === "duplicate" ? "acknowledge" : "acknowledge";
  } catch {
    // The handler threw, so the claim rolled back with it (see `claimEvent`).
    // Not acknowledging is how the runtime asks for a redelivery; the handler
    // never sees an acknowledgement to withhold.
    return "retry";
  }
}

export interface ConsumerRuntime {
  /** Runs until `stop()`. Never rejects: a broker that is down is an expected
   * state, not a crash. */
  start(): void;
  stop(): Promise<void>;
  /** One fetch-and-decide pass, for tests and for the walk script — the same
   * code path `start` runs, so nothing is proven about a loop only tests use. */
  pollOnce(): Promise<{ handled: number; duplicates: number; retried: number }>;
}

export function createConsumerRuntime({
  durable,
  handler,
  logger,
  db = createDb(createPool()),
  url = process.env.RELAY_NATS_URL ?? DEFAULT_NATS_URL,
  batch = BATCH,
  filterSubject = ALL_EVENTS_SUBJECT,
  fromNewOnly = false,
}: {
  durable: string;
  handler: EventHandler;
  logger: Logger;
  db?: Db;
  url?: string;
  batch?: number;
  /** Which subjects this consumer wants. The default is everything, which is
   * what the recorder needs; a narrower filter is how chapter 3.5's dispatcher
   * will subscribe to the event types a customer asked for, and how a test
   * scopes itself to one environment's subject rather than replaying the whole
   * stream (contracts §consumer). */
  filterSubject?: string;
  /** Start at the head rather than at the beginning. A durable consumer's
   * default is to deliver everything the stream still holds — which is correct
   * for a consumer that must not miss anything, and impractical for a test that
   * would otherwise replay twelve thousand events from earlier chapters before
   * reaching its own. */
  fromNewOnly?: boolean;
}): ConsumerRuntime {
  let connection: NatsConnection | null = null;
  let running = false;
  let loop: Promise<void> = Promise.resolve();

  /** Lazy, like the publisher's: the api must start and serve writes with the
   * broker unreachable. The durable consumer is created if absent and left
   * alone if present, so two instances starting together share the position
   * rather than fighting over it (research R8). */
  async function connection_(): Promise<NatsConnection> {
    if (connection && !connection.isClosed()) return connection;
    const nc = await connect({ servers: url });
    await ensureStream(nc);
    const jsm = await nc.jetstreamManager();
    const exists = await jsm.consumers
      .info(STREAM, durable)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await jsm.consumers.add(STREAM, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        ack_wait: ACK_WAIT_NS,
        max_deliver: MAX_DELIVER,
        max_ack_pending: MAX_ACK_PENDING,
        filter_subject: filterSubject,
        ...(fromNewOnly ? { deliver_policy: DeliverPolicy.New } : {}),
      });
    }
    connection = nc;
    return nc;
  }

  function parse(message: JsMsg): OutboxEvent | null {
    try {
      const result = outboxEventSchema.safeParse(
        JSON.parse(new TextDecoder().decode(message.data)),
      );
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  async function pollOnce(): Promise<{
    handled: number;
    duplicates: number;
    retried: number;
  }> {
    const nc = await connection_();
    const consumer = await nc.jetstream().consumers.get(STREAM, durable);
    const messages = await consumer.fetch({
      max_messages: batch,
      expires: 1_000,
    });

    let handled = 0;
    let duplicates = 0;
    let retried = 0;

    for await (const message of messages) {
      const parsed = parse(message);
      let result: ClaimResult = "duplicate";
      const outcome = await decideOutcome({
        parsed,
        attempt: message.info.deliveryCount,
        claim: async (effect) => {
          result = await claimEvent(db, durable, parsed!.id, effect);
          return result;
        },
        handler,
      });

      if (outcome === "terminate") {
        // Stops the redelivery for good. The chapter says out loud that nothing
        // catches what lands here.
        message.term();
        logger.log("error", "consumer.unparseable", {
          consumer: durable,
          stream_sequence: message.seq,
        });
        continue;
      }
      if (outcome === "retry") {
        message.nak();
        retried += 1;
        continue;
      }
      message.ack();
      if (result === "duplicate") duplicates += 1;
      else handled += 1;
    }

    return { handled, duplicates, retried };
  }

  async function run(): Promise<void> {
    while (running) {
      try {
        const { handled, duplicates, retried } = await pollOnce();
        if (handled + duplicates + retried > 0) {
          // Counts, never payloads. A message body in a log line is a tenant's
          // data in an operator's terminal (NFR-SEC-06).
          logger.log("info", "consumer.batch", {
            consumer: durable,
            handled,
            duplicates,
            retried,
          });
          continue;
        }
      } catch (error) {
        logger.log("error", "consumer.poll_failed", {
          consumer: durable,
          error: String(error),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
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
      if (connection && !connection.isClosed()) await connection.drain();
      connection = null;
    },
    pollOnce,
  };
}
