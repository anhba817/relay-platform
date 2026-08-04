import { messageCreatedSchema, type Message } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
// A NAMED import, not a default: ioredis is CommonJS, the gateway is ESM,
// and without esModuleInterop a default import of a CJS module hands you
// the module.exports namespace — which is not constructable. TypeScript
// says so plainly ("This expression is not constructable"); the fix is to
// take the named export the package actually provides.
import { Redis } from "ioredis";

// The fan-out fabric (chapter 2.6, ADR-07): Redis pub/sub, one subject per
// channel — `chan:{channel_id}`. The instance that handled a send publishes
// the committed message AFTER the api's response; every instance hosting a
// member of that channel is subscribed and delivers to its local sockets.
//
// This fabric is AT-MOST-ONCE by design. No acks, no replay, no consumer
// groups. A frame that misses a subscriber is simply gone — and that is
// acceptable because it is RECOVERABLE: sequences live in Postgres, cursors
// live with the client, and 2.7's resume path turns any gap into a
// backfill. Durability was never this layer's job (constitution IV:
// nothing in Redis is a source of truth).
//
// ioredis over node-redis for subscriber-mode ergonomics: a subscribed
// connection cannot issue ordinary commands, so publisher and subscriber
// must be two connections — ioredis models that as two client objects whose
// lifecycles match the session registry's.

export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** One subject per channel: an instance receives only frames it can
 * actually deliver, and a pathological channel saturates its own subject
 * rather than every gateway's inbox. */
export function subjectFor(channelId: string): string {
  return `chan:${channelId}`;
}

export interface Fanout {
  /** Register the delivery callback. Set by the session layer at wiring
   * time — the fabric knows how to receive, the sessions know who to
   * hand it to. */
  onDelivery(handler: (channelId: string, message: Message) => void): void;
  /** Publish a committed message to its channel's subject. A failure here
   * costs delivery latency, never durability. */
  publish(message: Message): Promise<void>;
  subscribe(channelId: string): Promise<void>;
  unsubscribe(channelId: string): Promise<void>;
  close(): Promise<void>;
}

export interface FanoutOptions {
  url?: string;
  logger: Logger;
}

export function createFanout({
  url = process.env.RELAY_REDIS_URL ?? DEFAULT_REDIS_URL,
  logger,
}: FanoutOptions): Fanout {
  let deliver: (channelId: string, message: Message) => void = () => {};
  const publisher = new Redis(url);
  const subscriber = new Redis(url);
  // Reference-counted, because two users of the same channel on one
  // instance must not unsubscribe each other.
  const counts = new Map<string, number>();

  subscriber.on("message", (subject: string, raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.log("error", "fanout.unparsable", { subject });
      return;
    }
    // The fabric is inside the trust boundary, and frames are STILL
    // validated: "inside" is one compromised dependency away from
    // "outside", and a malformed payload must not reach a client.
    const message = messageCreatedSchema.shape.payload.safeParse(parsed);
    if (!message.success) {
      logger.log("error", "fanout.invalid_payload", { subject });
      return;
    }
    deliver(message.data.channel, message.data);
  });

  return {
    onDelivery(handler) {
      deliver = handler;
    },
    async publish(message) {
      try {
        await publisher.publish(
          subjectFor(message.channel),
          JSON.stringify(message),
        );
      } catch (error) {
        // Delivery is allowed to fail; the message is already durable and
        // 2.7's resume will find it. Log and move on.
        logger.log("error", "fanout.publish_failed", {
          channel: message.channel,
          error: String(error),
        });
      }
    },
    async subscribe(channelId) {
      const next = (counts.get(channelId) ?? 0) + 1;
      counts.set(channelId, next);
      if (next === 1) await subscriber.subscribe(subjectFor(channelId));
    },
    async unsubscribe(channelId) {
      const next = (counts.get(channelId) ?? 1) - 1;
      if (next <= 0) {
        counts.delete(channelId);
        await subscriber.unsubscribe(subjectFor(channelId));
      } else {
        counts.set(channelId, next);
      }
    },
    async close() {
      subscriber.disconnect();
      publisher.disconnect();
    },
  };
}
