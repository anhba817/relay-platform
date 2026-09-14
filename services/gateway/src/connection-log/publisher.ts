// The gateway's first broker client, and the count is the subject rather than a detail:
// ADR-07 refuses core NATS for fan-out on an argument about how many client libraries
// this service holds. It held five dependencies and none of them a broker; it holds six
// now. The fan-out decision does not change -- ADR-10 keeps presence in Redis, so Redis
// is mandatory here regardless -- but the sentence that PRICED it stops being true.
import { connect, type NatsConnection } from "nats";

import type { Logger } from "@relay/service-kit";

import type { ConnectionPublisher, PublishableRecord } from "./event.js";

export const DEFAULT_NATS_URL = "nats://localhost:4222";

/** ONE CLIENT, CREATED ONCE, SHARED, CONNECTED LAZILY.
 *
 * LAZY BECAUSE A BROKER THAT IS DOWN AT BOOT MUST NOT COST A SOCKET. The gateway's job
 * is terminating WebSockets; an analytical publisher that refused to start would make a
 * dashboard's dependency into the product's, which is constitution III inverted. So the
 * connection is attempted on the first flush and retried on the next one.
 *
 * AND IT DOES NOT CREATE THE STREAM. `ensureAnalyticsStream` belongs to the api. A
 * gateway that ensured it would also ask for `replicas > 1` under `NODE_ENV=production`
 * and be refused in non-clustered mode (049-2) -- so there is nothing here to retry and
 * nothing to get wrong. A publish to a stream that does not exist comes back 503, which
 * the buffer treats as any other failure: the record stays and goes again. */
export function createConnectionPublisher({
  url = process.env.RELAY_NATS_URL ?? DEFAULT_NATS_URL,
  logger,
}: {
  url?: string;
  logger: Logger;
}): ConnectionPublisher {
  let nc: NatsConnection | null = null;
  let connecting: Promise<NatsConnection> | null = null;
  let closed = false;

  /** ONE IN-FLIGHT ATTEMPT, SHARED. A flush publishes up to `MAX_BUFFERED` records at
   *  once and every one of them calls this; without the shared promise a cold start
   *  would open four thousand connections to a broker that is already refusing one. */
  async function client(): Promise<NatsConnection> {
    if (closed) throw new Error("connection log publisher is closed");
    if (nc !== null) return nc;
    connecting ??= connect({ servers: url, name: "gateway-connection-log" })
      .then((c) => {
        nc = c;
        connecting = null;
        return c;
      })
      .catch((error: unknown) => {
        connecting = null;
        throw error;
      });
    return connecting;
  }

  return {
    /** One JetStream message per record. The deduplication id goes on the message, so
     *  a redelivered publish of the same record collapses inside the broker's window
     *  and a `ReplacingMergeTree` keyed on the record's own key catches the rest. */
    async publish(record: PublishableRecord): Promise<void> {
      const c = await client();
      await c
        .jetstream()
        .publish(record.subject, JSON.stringify(record.payload), {
          msgID: record.id,
        });
    },
    async close(): Promise<void> {
      closed = true;
      const c = nc;
      nc = null;
      if (c === null) {
        // Nothing was ever opened, which is the ordinary case for a gateway that ran
        // with the broker away. Saying so once beats a silent no-op.
        logger.log("info", "connection_log.publisher_never_connected", {});
        return;
      }
      // DRAIN RATHER THAN CLOSE. `drain()` waits for published messages to be flushed
      // to the server; `close()` does not, and the last flush before a deploy is
      // exactly the one worth keeping.
      await c.drain();
    },
  };
}
