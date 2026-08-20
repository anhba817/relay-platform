import { Redis } from "ioredis";

// The gateway's counter (chapter 3.8, research R12, R20).
//
// ITS OWN CLIENT, not fanout's, and that is forced rather than preferred.
// `Fanout` is a closed interface — `onDelivery`, `publish`, `subscribe`,
// `unsubscribe`, `close` — and exposes neither of the two clients it holds. One
// of them is a SUBSCRIBER, and a Redis connection in subscribe mode cannot run
// `INCR`. And `fanout` is optional in the session server, so a limiter riding its
// lifecycle would vanish in every configuration that has no fabric — which is
// every chapter-2.5 test.
//
// So: one more client, and a `close()` the session server calls. `fanout.ts`
// already sets that precedent for this service.
//
// THE SAME KEYS THE API USES. Two services increment one bucket, which is why
// the counter lives in Redis rather than in either process: neither can see the
// other's memory, and a socket send has to count against the same `send` budget a
// REST send does or a client could double its allowance by opening a socket
// (research R11).

export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** The window an instant belongs to. Floored, so two instances agree without
 * coordinating — the same arithmetic as the api's, deliberately duplicated
 * rather than shared: a package for two small functions would be an abstraction
 * constitution VII asks to be justified, and this one could not be. */
export function windowStartFor(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/** Is this count past the allowance?
 *
 * `null` — the store could not be reached — is NOT over. Both of the gateway's
 * limits are tenant limits, so they fail open like the api's: Redis is not a
 * source of truth, and a cache outage is not a reason to refuse a paying
 * customer's traffic. */
export function overLimit(count: number | null, limit: number): boolean {
  if (count === null) return false;
  return count > limit;
}

/** What one counted operation decided, and everything a refusal has to say.
 *
 * The api reports the same four numbers in three headers plus `Retry-After`;
 * the gateway needs them for the handshake refusal, which IS an HTTP response
 * and can carry headers. The frame refusal cannot — there is nowhere on an
 * `error` frame to put them — which is why the socket's two refusals do not
 * look alike (research R7). */
export interface Decision {
  over: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds, matching `X-RateLimit-Reset`. */
  resetSeconds: number;
  /** Whole seconds until the window turns over, for `Retry-After`. At least 1:
   * `Retry-After: 0` invites an immediate retry that is certain to fail. */
  retryAfterSeconds: number;
}

/** The arithmetic, with no store in it — so a window boundary is a test rather
 * than a wait. A `null` count means the store could not be reached. */
export function decide(
  count: number | null,
  limit: number,
  nowMs: number,
  windowMs: number,
): Decision {
  const reset = windowStartFor(nowMs, windowMs) + windowMs;
  return {
    over: overLimit(count, limit),
    limit,
    remaining: Math.max(0, limit - (count ?? 0)),
    resetSeconds: Math.ceil(reset / 1_000),
    retryAfterSeconds: Math.max(1, Math.ceil((reset - nowMs) / 1_000)),
  };
}

export interface GatewayLimits {
  /** Count one operation and report what that decided. */
  spend(
    environmentId: string,
    operation: "connect" | "send",
    limit: number,
  ): Promise<Decision>;
  close(): Promise<void>;
}

const WINDOW_MS = 60_000;
const DOWN_WINDOW_MS = 5_000;

export function createGatewayLimits(
  url: string = process.env["RELAY_REDIS_URL"] ?? DEFAULT_REDIS_URL,
): GatewayLimits {
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  });
  // A dead store is an expected state, not an exception. Without a listener
  // ioredis emits `error` on an EventEmitter with none attached and Node turns
  // that into an unhandled exception — the gateway would die for the thing it is
  // designed to survive.
  redis.on("error", () => {});

  // A known-down store is not retried on the connect path. Waiting out a connect
  // timeout per handshake would turn a cache outage into a slow one, and
  // NFR-PRF-04 asks for a handshake under a second (research R34).
  let downUntil = 0;

  return {
    async spend(environmentId, operation, limit) {
      const now = Date.now();
      if (now < downUntil) return decide(null, limit, now, WINDOW_MS);
      const key = `rl:${environmentId}:${operation}:${windowStartFor(now, WINDOW_MS)}`;
      try {
        const count = await redis.incr(key);
        if (count === 1) await redis.pexpire(key, WINDOW_MS);
        downUntil = 0;
        return decide(count, limit, now, WINDOW_MS);
      } catch {
        downUntil = now + DOWN_WINDOW_MS;
        return decide(null, limit, now, WINDOW_MS);
      }
    },

    async close() {
      redis.disconnect();
    },
  };
}
