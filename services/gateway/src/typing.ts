import {
  subjectForTyping,
  typingFabricSchema,
  type TypingFabric,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
import { Redis } from "ioredis";

// Typing's gateway half (chapter 3.21, FR-RTM-05, FR-RTM-08).
//
// A FOURTH FABRIC, AND THE FIRST THIS SERVICE BOTH PUBLISHES AND CONSUMES.
// `chan:{channel_id}` is published by the api; `presence:{channel_id}` is
// published here but never read back for delivery; `member:{…}` is published by
// the api again. Typing is neither: a client's signal arrives at its own gateway
// over the socket, that instance puts it on the fabric, and the same instance is
// subscribed because it holds members of that channel. **Both roles coexist on
// every instance.**
//
// TWO CLIENTS, AND THE TASK LIST SAID ONE. It carried chapter 3.20's finding
// forward — that module was "written with two by analogy and the second was
// created, listened to, closed and never used" — to a module with a different
// shape. That chapter's gateway half only ever RECEIVED; its api did the
// publishing. Here there is no api in the path, and `fanout.ts:33` states the
// rule this module has to obey:
//
//     a subscribed connection cannot issue ordinary commands, so publisher and
//     subscriber must be two connections
//
// `PUBLISH` is an ordinary command. One client would subscribe successfully and
// then fail every publish it made. **A lesson from the previous chapter is a
// claim about that chapter's code, and it transfers only when the shapes match.**
//
// NOTHING HERE IS STORED. No key, no TTL, no timer per indicator. The five-second
// expiry is the receiving client's, because `typingSchema` carries no `state`
// field and no frame ends an indicator (FR-009). What this module holds is
// transport and a reference count, and both die with the process.

export const DEFAULT_REDIS_URL = "redis://localhost:6379";

export interface Typing {
  /** Register the delivery callback. Set by the session layer at wiring time. */
  onSignal(handler: (signal: TypingFabric) => void): void;
  /** Put one signal on its channel's subject. Failures are swallowed and logged:
   * a typing indicator that does not arrive is a cosmetic loss that the next
   * renewal corrects, and it must never fail the socket that sent it (FR-015). */
  publish(signal: TypingFabric): Promise<void>;
  subscribe(channelId: string): Promise<void>;
  unsubscribe(channelId: string): Promise<void>;
  close(): Promise<void>;
}

export interface TypingOptions {
  url?: string;
  logger: Logger;
}

export function createTyping({
  url = process.env["RELAY_REDIS_URL"] ?? DEFAULT_REDIS_URL,
  logger,
}: TypingOptions): Typing {
  // The subscriber keeps ioredis's default retry, as chapter 3.20's does and for
  // the same reason: it MUST reconnect when the store comes back, which is what
  // "the next signal arrives without a restart" rests on.
  const subscriber = new Redis(url);
  const publisher = new Redis(url);

  // THE STATED REASON IS NFR-OBS-01, NOT PROCESS DEATH. `limits.ts` says a missing
  // listener kills the gateway; chapter 3.18 measured that against ioredis 6.0.0
  // and the process stays alive, printing `[ioredis] Unhandled error event: …`
  // itself. The accurate reason is that those lines are unstructured and unbounded.
  //
  // ONE LISTENER PER CLIENT. Two clients, two listeners — and a test that emits on
  // only one of them proves half of this.
  for (const [role, client] of [
    ["subscriber", subscriber],
    ["publisher", publisher],
  ] as const) {
    client.on("error", (error: unknown) => {
      logger.log("error", "typing.failed", {
        op: "connection",
        role,
        error: String(error),
      });
    });
  }

  let deliver: (signal: TypingFabric) => void = () => {};

  // Reference-counted, because two members of one channel on one instance must not
  // unsubscribe each other. `fanout.ts`, `presence.ts` and `membership.ts` keep the
  // same map over the same ids, and this is the fourth.
  const counts = new Map<string, number>();

  async function failable<T>(
    op: string,
    work: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      // Swallowed on purpose (FR-015). A typing failure must not fail a
      // connection, a send, or a message delivery — the socket carrying the
      // signal is carrying everything else too.
      logger.log("error", "typing.failed", { op, error: String(error) });
      return null;
    }
  }

  subscriber.on("message", (subject: string, raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.log("error", "typing.invalid_payload", { subject });
      return;
    }
    // Validated on receipt even though the fabric is inside the trust boundary.
    // `fanout.ts:77-79` states the reason and it is unchanged here: "inside" is one
    // compromised dependency away from "outside", and a malformed payload must not
    // reach a client.
    const signal = typingFabricSchema.safeParse(parsed);
    if (!signal.success) {
      logger.log("error", "typing.invalid_payload", { subject });
      return;
    }
    deliver(signal.data);
  });

  return {
    onSignal(handler) {
      deliver = handler;
    },

    async publish(signal) {
      await failable("publish", async () => {
        await publisher.publish(
          subjectForTyping(signal.channel),
          JSON.stringify(signal),
        );
        logger.log("info", "typing.published", {
          channel: signal.channel,
          user: signal.user,
        });
      });
    },

    async subscribe(channelId) {
      const subject = subjectForTyping(channelId);
      const next = (counts.get(channelId) ?? 0) + 1;
      counts.set(channelId, next);
      if (next === 1) {
        await failable("subscribe", () => subscriber.subscribe(subject));
      }
    },

    async unsubscribe(channelId) {
      const current = counts.get(channelId);
      // A channel never subscribed, or already released. Not an error: the session
      // layer releases on close and on revocation, and a connection can meet both.
      if (current === undefined) return;
      const next = current - 1;
      if (next <= 0) {
        counts.delete(channelId);
        await failable("unsubscribe", () =>
          subscriber.unsubscribe(subjectForTyping(channelId)),
        );
      } else {
        counts.set(channelId, next);
      }
    },

    async close() {
      counts.clear();
      subscriber.disconnect();
      publisher.disconnect();
    },
  };
}
