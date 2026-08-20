import { Redis } from "ioredis";

import { WINDOW_MS } from "./policy";

// The counter store (chapter 3.8, research R1).
//
// THE ONLY MODULE IN THE API PERMITTED TO HOLD A REDIS CLIENT, enforced by
// `no-restricted-imports` in `eslint.config.mjs` — the same confinement the
// database driver has, for the same stated reason. The keys are per environment,
// so an unrestricted client would let any handler read or write another tenant's
// counter, and constitution I makes that a correctness property rather than a
// convention.
//
// TWO COMMANDS, NO LUA. `INCR` returns the new value atomically on its own, and
// `EXPIRE` is set only when the increment returns 1 — the first write of a
// window. A token bucket would need read-timestamp-compute-write, which across
// instances needs a script, which is a second language in the request path
// (constitution VII).
//
// The TTL does the cleanup: a key dies when its window ends and nothing
// accumulates. Chapter 3.7's baseline and this chapter's own both found suites
// broken by shared stores that grew without bound, so a counter that tidies
// itself is worth the sentence.

export interface CounterStore {
  /** Count one operation against a key, returning the new count — or `null` when
   * the store could not be reached.
   *
   * NULL IS NOT ZERO AND NOT AN ERROR. It means "we are not counting", and each
   * caller decides what that is worth: the tenant limiter serves the request
   * (FR-010, Redis is not a source of truth), and the auth limiter falls back to
   * counting in memory rather than letting an attacker through (FR-011). Same
   * signal, opposite conclusions, which is the chapter's argument in one return
   * type. */
  increment(key: string, nowMs: number): Promise<number | null>;
  close(): Promise<void>;
}

export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** The key. `rl:` is the prefix SAD §6.3 specifies; the operation and the
 * window's start are appended so one `INCR` reaches the right counter and the key
 * expires itself.
 *
 * That EXTENDS the SAD's three-segment `rl:{env}:{bucket}` rather than matching
 * it, and the extension is what makes the TTL do the cleanup. */
export function counterKey(
  scope: string,
  operation: string,
  windowStartMs: number,
): string {
  return `rl:${scope}:${operation}:${windowStartMs}`;
}

export function createCounterStore(
  url: string = process.env["RELAY_REDIS_URL"] ?? DEFAULT_REDIS_URL,
): CounterStore {
  // `lazyConnect` so constructing the store never blocks start-up.
  //
  // THE OFFLINE QUEUE STAYS ON, and the first draft had it off. With it off, the
  // very first command is rejected because the lazy connection has not been
  // established yet — so the first request an api instance ever serves reports no
  // count, degrades, and looks like a Redis outage. The integration suite caught
  // it as `expected null to be '599'` on the first test and three passes after
  // it.
  //
  // Failing fast on a store that is genuinely down is then `maxRetriesPerRequest:
  // 0` and a short `connectTimeout`: a queued command rejects as soon as the
  // connection attempt fails rather than waiting out a retry schedule. A limiter
  // that waits is worse than one that does not count, because the request it is
  // holding is a customer's.
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  });
  // A dead store is an expected state here, not an exception. Without a listener
  // ioredis emits `error` on an EventEmitter with none attached, which Node turns
  // into an unhandled exception and the api dies for the thing it was designed to
  // survive.
  redis.on("error", () => {});

  return {
    async increment(key, nowMs) {
      void nowMs;
      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.pexpire(key, WINDOW_MS);
        }
        return count;
      } catch {
        return null;
      }
    },

    async close() {
      redis.disconnect();
    },
  };
}
