import { subjectForChannel, type Message } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
// A NAMED import: ioredis is CommonJS and this service is ESM.
import { Redis } from "ioredis";

/** The api's half of the live fan-out (chapter 3.18, FR-004).
 *
 * WHY THE API HAS ITS OWN PUBLISHER instead of reusing the gateway's
 * `createFanout`. Three reasons, in order of how much they cost to learn:
 *
 * 1. It cannot import it. `services/api` does not depend on the gateway, and it
 *    should not — the shared thing is the subject grammar, which moved to
 *    `@relay/protocol` for exactly this.
 * 2. It needs half of it. `createFanout` builds two connections because a
 *    subscribed ioredis client cannot issue ordinary commands. The api never
 *    subscribes, so it takes one.
 * 3. IT MUST NOT COPY THE GATEWAY'S CLIENT OPTIONS. `createFanout` uses
 *    `new Redis(url)` with defaults and attaches no `error` listener, which is
 *    survivable for a long-lived gateway and not for a request handler. The
 *    options below come from `limits/store.ts`, which is the api's own Redis
 *    client and learned this the hard way.
 *
 * NO OFF-SWITCH, and that is a decision rather than an omission (T009c).
 * Four api modules carry one — `RELAY_OUTBOX_RELAY`, `RELAY_DELIVERY_RELAY`,
 * `RELAY_NOTIFICATION_RELAY`, `RELAY_EVENT_CONSUMER` — and CI sets them off in
 * the lane because "a background daemon draining the table two suites are
 * asserting on is a race between test files, not a property". Every one of
 * those is a *daemon* that polls shared state. This is a synchronous publish to
 * `chan:{uuid}`, and a suite that did not create that channel cannot observe it.
 * The stronger reason is the one this chapter is about: a switch would let the
 * lane run green with the publish disabled, which is the false-green shape the
 * whole feature exists to remove. */
/** The DI token, declared HERE rather than in `messages.module.ts`.
 *
 * A CIRCULAR IMPORT OTHERWISE, and Nest reports it as a missing dependency
 * rather than as a cycle: "Nest can't resolve dependencies of the
 * MessagesController (MessagesService, Repository, ?)". The module imports the
 * controller, so a controller importing the token from the module closes the
 * loop and the token is `undefined` when the decorator metadata is read. Beside
 * the interface it names, nobody imports anybody twice. */
export const MESSAGE_PUBLISHER = "MESSAGE_PUBLISHER";

export interface MessagePublisher {
  /** Publish a committed message to its channel's subject. NEVER REJECTS —
   * delivery is allowed to fail, because the row is already durable and 2.7's
   * resume will find it (ADR-07, constitution IV). */
  publish(message: Message, context: PublishContext): Promise<void>;
  close(): Promise<void>;
}

/** What the failure has to be findable by. NFR-OBS-01 wants a request id and a
 * tenant id in every structured log, and NFR-OBS-06 wants five-minute
 * traceability from the former. The gateway's equivalent line carries neither,
 * correctly — it is not inside a request. This one is. */
export interface PublishContext {
  requestId: string;
  environmentId: string;
}

export const DEFAULT_FANOUT_REDIS_URL = "redis://localhost:6379";

/** How long a known-dead Redis is left alone. Lifted from
 * `limits/store.ts`'s `DOWN_WINDOW_MS`, and the reason is that file's: "FAILING
 * OPEN IS NOT FREE IF IT FAILS SLOWLY… each request paid a second or more,
 * twice." The options alone were the slow version; the window is the fix, and
 * the first draft of chapter 3.18's contract copied the options without it. */
const DOWN_WINDOW_MS = 5_000;

export interface PublisherOptions {
  url?: string;
  logger: Logger;
  now?: () => number;
}

export function createMessagePublisher({
  url = process.env["RELAY_REDIS_URL"] ?? DEFAULT_FANOUT_REDIS_URL,
  logger,
  now = () => Date.now(),
}: PublisherOptions): MessagePublisher {
  const redis = new Redis(url, {
    // A queued command rejects as soon as the connection attempt fails, rather
    // than waiting out a retry schedule. On a request path that difference is
    // the whole of NFR-PRF-02's 150 ms budget.
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  });
  // A dead fan-out is an expected state, not an exception. Without a listener
  // ioredis emits `error` on an EventEmitter with none attached and Node turns
  // that into an unhandled exception — the api would die for the thing it is
  // designed to survive. `createFanout` has no such listener; that is a gap
  // this chapter records rather than inherits.
  redis.on("error", () => {});

  let downUntil = 0;

  return {
    async publish(message, context) {
      // A known-down store is not retried on the request path. The first
      // failure opens a window; while it is open every call returns
      // immediately, which is the same outcome the caller already handles.
      if (now() < downUntil) return;
      try {
        await redis.publish(
          subjectForChannel(message.channel),
          JSON.stringify(message),
        );
        downUntil = 0;
      } catch (error) {
        downUntil = now() + DOWN_WINDOW_MS;
        logger.log("error", "fanout.publish_failed", {
          channel: message.channel,
          message_id: message.id,
          request_id: context.requestId,
          environment_id: context.environmentId,
          error: String(error),
        });
      }
    },
    async close() {
      redis.disconnect();
    },
  };
}
