// The ingester — the consumer chapter 3.20 promised and did not build.
//
// `ANALYTICS` has carried one record per webhook delivery attempt since that chapter, with
// seven-day retention and `discard: old`, and nothing has ever read it. The stream's own
// comment says so: "no acknowledgement anywhere: nothing consumes this stream in this
// chapter." This is the chapter it was waiting for.
//
// IT DOES NOT REUSE `createConsumerRuntime`, AND THAT IS THE ARGUMENT RATHER THAN AN
// INCONVENIENCE. That runtime exists because "a future consumer forgets to dedupe → double
// webhooks / double metering", mitigated by "a consumer template with dedup built in" -- and
// the dedup it has built in is `claimEvent`, a PostgreSQL transaction. Constitution III
// keeps the operational and analytical paths apart, so the template written to describe this
// consumer is the one thing this consumer may not use. Deduplication happens in the table
// instead, on the record's own key.
import { AckPolicy, connect } from "nats";

import { ALL_ANALYTICS_SUBJECT, ANALYTICS_STREAM } from "@relay/protocol";
import { createLogger } from "@relay/service-kit";

import { createClickHouse } from "./clickhouse.js";
import { BATCH_MS, DURABLE, ingestOnce } from "./ingest.js";

const DEFAULT_NATS_URL = "nats://localhost:4222";

const ACK_WAIT_NS = 30 * 1_000_000_000;

/** NO REDELIVERY LIMIT, AND THAT IS A DECISION ABOUT A DIFFERENT FAILURE.
 *
 * Both existing consumers set one -- MAX_DELIVER = 5 on the api's runtime, 10 on the
 * dispatcher, each at a 30-second ack_wait. For a webhook endpoint that is sound: one that
 * has failed ten times is probably gone, and retrying it forever helps nobody.
 *
 * A store that is restarting is not an endpoint that is gone. Measured at max_deliver 3: the
 * message is delivered on rounds 1, 2 and 3 and NEVER AGAIN, while the stream still holds it
 * and the consumer reports `num_pending 0`. At five attempts and thirty seconds, two and a
 * half minutes of ClickHouse being down strands everything in flight -- and the loss hides
 * from the instrument you would reach for, because stream depth stays high and consumer lag
 * goes to zero.
 *
 * So the queue's seven-day retention is the only bound. That makes the poison case
 * load-bearing rather than tidy: a payload that will never parse is terminated at the parse,
 * or it comes back until the retention expires. Retry forever on transport, terminate at
 * parse. One rule, two arms. */
const MAX_DELIVER = -1;

export async function main(): Promise<void> {
  const logger = createLogger("ingester");
  const url = process.env["RELAY_NATS_URL"] ?? DEFAULT_NATS_URL;
  const once = process.argv.includes("--once");

  const nc = await connect({ servers: url });
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(ANALYTICS_STREAM, {
    durable_name: DURABLE,
    ack_policy: AckPolicy.Explicit,
    ack_wait: ACK_WAIT_NS,
    max_deliver: MAX_DELIVER,
    filter_subject: ALL_ANALYTICS_SUBJECT,
  }).catch(() => undefined); // already there; leave it alone

  const store = createClickHouse();
  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  do {
    try {
      const { written, malformed } = await ingestOnce({ nc, store, logger });
      if (written > 0 || malformed > 0) {
        logger.log("info", "ingester.batch", { written, malformed });
      }
    } catch (error) {
      // The store is unreachable, or the insert was refused. Nothing was acknowledged, so
      // the broker will offer these records again -- forever, bounded only by retention.
      logger.log("error", "ingester.batch_failed", { error: String(error) });
      await new Promise((r) => setTimeout(r, BATCH_MS));
    }
  } while (running && !once);

  await nc.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`ingester failed: ${String(error)}\n`);
    process.exit(1);
  });
}
