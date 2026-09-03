import {
  messageCreatedSchema,
  subjectForChannel,
  subjectForChannelRevision,
  isChannelRevisionSubject,
  revisionFabricSchema,
  type RevisionFabric,
  type Message,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
// A NAMED import, not a default: ioredis is CommonJS, the gateway is ESM,
// and without esModuleInterop a default import of a CJS module hands you
// the module.exports namespace — which is not constructable. TypeScript
// says so plainly ("This expression is not constructable"); the fix is to
// take the named export the package actually provides.
import { Redis } from "ioredis";

// The fan-out fabric (chapter 2.6, ADR-07): Redis pub/sub, one subject per
// channel — `chan:{channel_id}`. Every instance hosting a member of that
// channel is subscribed and delivers to its local sockets.
//
// WHO PUBLISHES CHANGED IN CHAPTER 3.18. This comment used to say "the
// instance that handled a send publishes the committed message AFTER the api's
// response", which was true while a socket was the only way in. There are two
// publishers now: this one, for a socket send, and the api, for a REST send.
// The ordering also splits by transport — a socket can ack and then publish
// because it has two channels, and a request handler cannot, because its
// response IS the ack.
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

export interface Fanout {
  /** Register the delivery callback. Set by the session layer at wiring
   * time — the fabric knows how to receive, the sessions know who to
   * hand it to. */
  onDelivery(handler: (channelId: string, message: Message) => void): void;
  /** Publish a committed message to its channel's subject. A failure here
   * costs delivery latency, never durability. */
  publish(message: Message): Promise<void>;
  /** Chapter 3.23, ADR-24. Register the revision callback — an edit or a deletion of a
   * message that already exists.
   *
   * A SECOND CALLBACK ON THE SAME MODULE, not a second module. The revision subject's
   * subscription lifetime is IDENTICAL to the message subject's: the same channels, the
   * same reference counts, subscribed and dropped at the same moments. A module of its own
   * would duplicate that counting and add two more Redis clients to a service chapter 3.21
   * took to eight. */
  onRevision(handler: (channelId: string, revision: RevisionFabric) => void): void;
  /** Publish an edit or a deletion to its channel's revision subject. Same failure
   * contract as `publish`: delivery latency, never durability. */
  publishRevision(revision: RevisionFabric): Promise<void>;
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
  let deliverRevision: (channelId: string, revision: RevisionFabric) => void = () => {};
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
    // CHAPTER 3.23. TWO SUBJECTS ON ONE SUBSCRIBER, told apart by the prefix rather than
    // by guessing at the payload. Parsing against both schemas and taking whichever
    // succeeded would make a malformed revision look like a message.
    if (isChannelRevisionSubject(subject)) {
      const revision = revisionFabricSchema.safeParse(parsed);
      if (!revision.success) {
        logger.log("error", "fanout.invalid_payload", { subject });
        return;
      }
      deliverRevision(revision.data.message.channel, revision.data);
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
    onRevision(handler) {
      deliverRevision = handler;
    },
    async publishRevision(revision) {
      try {
        await publisher.publish(
          subjectForChannelRevision(revision.message.channel),
          JSON.stringify(revision),
        );
      } catch (error) {
        // Same contract as `publish` above: the edit or the tombstone is already
        // committed, and a client that missed the frame repairs by re-reading history —
        // which is what chapter 3.23's resume decision rests on.
        logger.log("error", "fanout.publish_failed", {
          channel: revision.message.channel,
          error: String(error),
        });
      }
    },
    async publish(message) {
      try {
        await publisher.publish(
          subjectForChannel(message.channel),
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
      if (next === 1) {
        // BOTH SUBJECTS, one reference count. They are co-extensive by construction: a
        // gateway that holds a socket for this channel wants its messages and its
        // revisions, and dropping one without the other would leave edits arriving for a
        // channel nobody is listening to — or worse, the reverse.
        await subscriber.subscribe(
          subjectForChannel(channelId),
          subjectForChannelRevision(channelId),
        );
      }
    },
    async unsubscribe(channelId) {
      const next = (counts.get(channelId) ?? 1) - 1;
      if (next <= 0) {
        counts.delete(channelId);
        await subscriber.unsubscribe(
          subjectForChannel(channelId),
          subjectForChannelRevision(channelId),
        );
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
