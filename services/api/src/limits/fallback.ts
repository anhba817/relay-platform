// The in-process counter the AUTH limiter falls back to when Redis is gone
// (chapter 3.8, research R3).
//
// THE TENANT LIMITER FAILS OPEN AND THIS ONE MUST NOT, and that asymmetry is the
// chapter's whole argument. Both are the same mechanism; what differs is what is
// on the other side of the limit. The tenant limiter protects Relay's capacity
// from a customer's traffic, and over-serving a paying customer for the length of
// a cache outage costs some capacity. This one protects a customer's credentials
// from an attacker, and over-serving an attacker costs the customer their
// account.
//
// So neither of the two obvious answers is right. Failing open is unbounded — a
// hole rather than a degradation. Failing closed converts a Redis restart into an
// authentication outage, which is worse than the attack it prevents for every
// customer who is not being attacked. The third answer is this: count in memory,
// same threshold, and let the guarantee weaken from "N per window across the
// fleet" to "N per window per instance". Three api instances give an attacker
// three times the attempts for the duration of the outage — a small multiple
// rather than infinity.
//
// THE CAP IS PART OF THE DECISION, NOT A DETAIL. A map keyed by
// attacker-controlled source address is a memory-exhaustion vector if it is
// unbounded, and a fallback that closed a brute-force hole by opening a worse one
// would not be worth having.
//
// AND IT STOPS ADMITTING RATHER THAN EVICTING. An eviction policy on this map is
// a policy the attacker drives: fill it, evict the entry that was counting them,
// start again. Refusing new keys degrades to "addresses already being tracked
// stay tracked", which is the safe direction.

interface Entry {
  count: number;
  windowStart: number;
}

export interface FallbackCounter {
  /** Count one failure against a key, returning the new count — or `null` when
   * the key could not be admitted because the map is full. A caller that gets
   * `null` has learned nothing about that address and must not treat it as
   * "under the threshold". */
  increment(key: string, nowMs: number): number | null;
  /** The current count for a key WITHOUT adding to it, or `null` when the key is
   * not tracked and the map is full.
   *
   * `null` and `0` are different answers and the caller must tell them apart:
   * zero means "tracked, nothing counted", null means "we have no idea". While
   * degraded, refusing an address we cannot track is the safe direction, and the
   * cap makes that a bounded population rather than everybody. */
  peek(key: string, nowMs: number): number | null;
  /** Live keys. Exposed for the test that proves the bound holds. */
  size(): number;
}

export function createFallbackCounter({
  windowMs,
  maxKeys,
}: {
  windowMs: number;
  maxKeys: number;
}): FallbackCounter {
  const entries = new Map<string, Entry>();

  return {
    increment(key, nowMs) {
      const start = Math.floor(nowMs / windowMs) * windowMs;
      const existing = entries.get(key);

      if (existing !== undefined) {
        if (existing.windowStart === start) {
          existing.count += 1;
          return existing.count;
        }
        // Same key, new window: reuse the slot rather than counting against the
        // cap twice.
        existing.count = 1;
        existing.windowStart = start;
        return 1;
      }

      if (entries.size >= maxKeys) {
        // Sweep what the current window has already outlived before refusing.
        // The cap is on LIVE keys, not on keys ever seen — an outage lasting
        // hours must not permanently refuse to count anybody new.
        for (const [k, v] of entries) {
          if (v.windowStart !== start) entries.delete(k);
        }
      }
      if (entries.size >= maxKeys) return null;

      entries.set(key, { count: 1, windowStart: start });
      return 1;
    },

    peek(key, nowMs) {
      const start = Math.floor(nowMs / windowMs) * windowMs;
      const existing = entries.get(key);
      if (existing === undefined) {
        return entries.size >= maxKeys ? null : 0;
      }
      return existing.windowStart === start ? existing.count : 0;
    },

    size() {
      return entries.size;
    },
  };
}
