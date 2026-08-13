import {
  AckPolicy,
  connect,
  DeliverPolicy,
  type JsMsg,
  type NatsConnection,
} from "nats";
import {
  ALL_DELIVERIES_SUBJECT,
  ALL_EVENTS_SUBJECT,
  DELIVERIES_STREAM,
} from "@relay/protocol";
import { createLogger, type Logger } from "@relay/service-kit";

import { createApiClient, type ApiClient } from "./api-client.js";
import { ATTEMPT_TIMEOUT_MS, deliverOnce, type DeliveryJob } from "./deliver.js";
import { expandOnce } from "./expand.js";

// The dispatcher (chapter 3.5) — the first service in this platform that exists
// because of constitution IV rather than in spite of it.
//
// TWO CONSUMERS, and they do different jobs on purpose:
//
//   events.>      -> expand one event into one delivery row per matching
//                    endpoint. A claimed write, so a redelivered event cannot
//                    double a customer's webhooks.
//   deliveries.>  -> post one delivery that the api's relay has decided is DUE.
//                    Nothing waits here: a delivery not yet due is a row, not a
//                    message the broker is holding (research R1, measured).
//
// Frameworkless and ESM, mirroring the gateway. ADR-15 binds NestJS to the API
// service only, and a second Nest application would be adopting a framework by
// momentum rather than by decision.

const EVENTS_STREAM = "EVENTS";

/** One durable per job. A durable name is a POSITION in a stream shared by every
 * instance using it, so two dispatchers divide the work rather than each
 * receiving everything (chapter 3.4's research R8).
 *
 * Overridable, and chapter 3.4's suites explain why: a test that shares the
 * production durable inherits every message every previous run left behind, and
 * a batch of twenty-five is quickly all backlog. A per-run durable with
 * `DeliverPolicy.New` is the same trick 2.1 used for environments and 2.6 for
 * subjects — the only namespace a stream position has is its name. */
export const EXPAND_DURABLE = "dispatcher-expand";
export const DELIVER_DURABLE = "dispatcher-deliver";

const BATCH = 25;
const ACK_WAIT_NS = 30 * 1_000_000_000;

/** The DELIVERY attempt budget lives in the api's tier table, not here. This
 * bound is only about how many times the BROKER redelivers a job the dispatcher
 * failed to process at all — a crash, or an api that was unreachable. Confusing
 * the two would let a broker redelivery consume a customer's retry. */
const MAX_DELIVER = 10;
const MAX_ACK_PENDING = 100;

const DEFAULT_NATS_URL = "nats://localhost:4222";
const DEFAULT_API_URL = "http://127.0.0.1:4000";

export interface Dispatcher {
  ready(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  /** One pass of each consumer, for tests and the walk script — the same code
   * path `start` runs, so nothing is proven about a loop only tests exercise. */
  pollOnce(): Promise<{ expanded: number; delivered: number }>;
}

export function createDispatcher({
  natsUrl = process.env["RELAY_NATS_URL"] ?? DEFAULT_NATS_URL,
  apiUrl = process.env["RELAY_API_URL"] ?? DEFAULT_API_URL,
  credential = process.env["RELAY_INTERNAL_CREDENTIAL"] ?? "",
  logger = createLogger("dispatcher"),
  api = createApiClient(apiUrl, credential),
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  durables = { expand: EXPAND_DURABLE, deliver: DELIVER_DURABLE },
  deliverPolicy = DeliverPolicy.All,
}: {
  natsUrl?: string;
  apiUrl?: string;
  credential?: string;
  logger?: Logger;
  api?: ApiClient;
  attemptTimeoutMs?: number;
  durables?: { expand: string; deliver: string };
  deliverPolicy?: DeliverPolicy;
} = {}): Dispatcher {
  let connection: NatsConnection | null = null;
  let running = false;
  let loop: Promise<void> = Promise.resolve();

  /** Lazy, like every other broker client in this workspace: an unreachable
   * broker must not stop the service from starting, and an unreachable API
   * service must not either — the work is durable in both directions. */
  async function connection_(): Promise<NatsConnection> {
    if (connection && !connection.isClosed()) return connection;
    const nc = await connect({ servers: natsUrl });
    const jsm = await nc.jetstreamManager();

    // The DELIVERIES stream is created by the API SERVICE, which publishes to
    // it. The dispatcher only consumes, so it does not define the stream — two
    // definitions of one stream is a drift waiting for the day they disagree.
    // Consumer creation below simply fails until the api has been up once, and
    // the poll loop retries; nothing is lost, because nothing is due yet either.

    for (const [stream, durable] of [
      [EVENTS_STREAM, durables.expand],
      [DELIVERIES_STREAM, durables.deliver],
    ] as const) {
      await jsm.consumers
        .add(stream, {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: deliverPolicy,
          ack_wait: ACK_WAIT_NS,
          max_deliver: MAX_DELIVER,
          max_ack_pending: MAX_ACK_PENDING,
          ...(stream === EVENTS_STREAM
            ? { filter_subject: ALL_EVENTS_SUBJECT }
            : { filter_subject: ALL_DELIVERIES_SUBJECT }),
        })
        // Created if absent, left alone if present: two dispatchers starting
        // together must share a position rather than fight over it.
        .catch(() => undefined);
    }
    connection = nc;
    return nc;
  }

  async function drain(
    stream: string,
    durable: string,
    handle: (msg: JsMsg) => Promise<"ack" | "term" | "retry">,
  ): Promise<number> {
    const nc = await connection_();
    const consumer = await nc.jetstream().consumers.get(stream, durable);
    const messages = await consumer.fetch({ max_messages: BATCH, expires: 1_000 });
    let handled = 0;
    for await (const msg of messages) {
      let decision: "ack" | "term" | "retry" = "retry";
      try {
        decision = await handle(msg);
      } catch (error) {
        // Not acknowledging IS how this asks for the work back. The api being
        // unreachable lands here and must not consume anything.
        logger.log("error", "dispatcher.handle_failed", {
          stream,
          error: String(error),
        });
      }
      if (decision === "ack") {
        msg.ack();
        handled++;
      } else if (decision === "term") {
        msg.term();
        handled++;
      }
    }
    return handled;
  }

  /** Deliveries, grouped by endpoint and run in parallel.
   *
   * THIS IS THE ISOLATION PROPERTY, and it is structural rather than a tuning
   * choice. FR-WHK-05 says one customer's endpoint must not delay deliveries to
   * another; processing a batch one message at a time makes that false the
   * moment a single endpoint hangs, because every delivery behind it waits out
   * a timeout it had nothing to do with.
   *
   * ONE in-flight attempt per endpoint, endpoints concurrent. Serialising WITHIN
   * an endpoint matters too: two attempts at once against the same customer
   * would let a retry overtake the attempt it is retrying, and a customer whose
   * server is already struggling is the last one to hand extra concurrency
   * (research R7). */
  async function drainByEndpoint(): Promise<number> {
    const nc = await connection_();
    const consumer = await nc.jetstream().consumers.get(
      DELIVERIES_STREAM,
      durables.deliver,
    );
    const messages = await consumer.fetch({ max_messages: BATCH, expires: 1_000 });

    const byEndpoint = new Map<string, { msg: JsMsg; job: DeliveryJob }[]>();
    for await (const msg of messages) {
      let job: DeliveryJob;
      try {
        job = msg.json<DeliveryJob>();
      } catch {
        logger.log("error", "deliver.undecodable", { seq: msg.seq });
        msg.term();
        continue;
      }
      const queue = byEndpoint.get(job.endpoint_id) ?? [];
      queue.push({ msg, job });
      byEndpoint.set(job.endpoint_id, queue);
    }

    let handled = 0;
    await Promise.all(
      [...byEndpoint.values()].map(async (queue) => {
        for (const { msg, job } of queue) {
          try {
            await deliverOnce(api, logger, job, attemptTimeoutMs);
          } catch (error) {
            // The API SERVICE is unreachable — the one failure this must not
            // absorb. Leaving the message unacknowledged is how the work comes
            // back; a customer's 500 never lands here, because that is an
            // outcome rather than an error.
            logger.log("error", "dispatcher.handle_failed", {
              stream: DELIVERIES_STREAM,
              error: String(error),
            });
            continue;
          }
          // Acknowledged whatever the customer said. A 500 is not the
          // dispatcher's failure to handle the job — it is the job's OUTCOME,
          // already recorded by the api, which has scheduled the next tier or
          // dead-lettered it. Redelivering here would retry outside the
          // schedule the customer was promised.
          msg.ack();
          handled++;
        }
      }),
    );
    return handled;
  }

  async function pollOnce(): Promise<{ expanded: number; delivered: number }> {
    const expanded = await drain(EVENTS_STREAM, durables.expand, async (msg) => {
      // `msg.json()` THROWS on bytes that are not JSON, and a throw here would
      // land in drain()'s catch and be treated as "ask for the work back" — so
      // bytes that can never parse would be redelivered until the broker's
      // attempt budget ran out. Chapter 3.4 settled this: the same bytes fail the
      // same way every time, so an unparseable payload is terminated on the FIRST
      // attempt. Decoding defensively is what keeps that promise here.
      let raw: unknown;
      try {
        raw = msg.json();
      } catch {
        logger.log("error", "expand.undecodable", { seq: msg.seq });
        return "term";
      }
      const outcome = await expandOnce(api, logger, raw);
      // A duplicate is acknowledged because it genuinely has been handled — by a
      // previous delivery of this same event.
      return outcome === "unparseable" ? "term" : "ack";
    });

    const delivered = await drainByEndpoint();

    return { expanded, delivered };
  }

  async function run(): Promise<void> {
    while (running) {
      try {
        const { expanded, delivered } = await pollOnce();
        if (expanded > 0 || delivered > 0) continue;
      } catch (error) {
        logger.log("error", "dispatcher.poll_failed", { error: String(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return {
    /** Force the consumers into existence without processing anything. A suite
     * using `DeliverPolicy.New` must create its position BEFORE it publishes, or
     * the message it is about to send lands before the consumer exists and is
     * never seen. */
    async ready(): Promise<void> {
      await connection_();
    },
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

// Entry point. `import.meta` rather than `require.main`: this package is ESM,
// unlike the api (ADR-15's dialect split).
if (import.meta.url === `file://${process.argv[1]}`) {
  const dispatcher = createDispatcher();
  dispatcher.start();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void dispatcher.stop().then(() => process.exit(0));
    });
  }
}
