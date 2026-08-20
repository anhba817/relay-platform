import { describe, expect, it } from "vitest";

import { createFallbackCounter } from "./fallback";

// The in-process counter the auth limiter falls back to when Redis is gone
// (chapter 3.8, research R3). Pure apart from the map it owns; every call takes
// the instant it should reason about.

const MINUTE = 60_000;

describe("the fallback counter", () => {
  it("counts per key within a window", () => {
    const c = createFallbackCounter({ windowMs: MINUTE, maxKeys: 100 });
    expect(c.increment("1.2.3.4", 0)).toBe(1);
    expect(c.increment("1.2.3.4", 10)).toBe(2);
    expect(c.increment("5.6.7.8", 10)).toBe(1);
  });

  it("starts again in the next window", () => {
    const c = createFallbackCounter({ windowMs: MINUTE, maxKeys: 100 });
    expect(c.increment("1.2.3.4", 0)).toBe(1);
    expect(c.increment("1.2.3.4", 59_999)).toBe(2);
    expect(c.increment("1.2.3.4", 60_000)).toBe(1);
  });

  it("STOPS ADMITTING NEW KEYS at the cap rather than evicting", () => {
    // The decision research R3 spent its argument on. An eviction policy on a map
    // keyed by attacker-controlled input is a policy the attacker drives: fill
    // the map, evict the entry that was counting them, start again.
    //
    // Refusing new keys degrades to "addresses we are already tracking stay
    // tracked", which is the safe direction — and the whole reason this
    // structure is written down rather than being an implementation detail.
    const c = createFallbackCounter({ windowMs: MINUTE, maxKeys: 2 });
    expect(c.increment("a", 0)).toBe(1);
    expect(c.increment("b", 0)).toBe(1);

    // Third key: not admitted, and says so.
    expect(c.increment("c", 0)).toBeNull();

    // The two already tracked keep counting.
    expect(c.increment("a", 0)).toBe(2);
    expect(c.increment("b", 0)).toBe(2);
  });

  it("admits a new key again once a window turns over", () => {
    // The cap is on live keys, not on keys ever seen. A window boundary clears
    // expired entries, so an outage lasting hours does not permanently refuse to
    // count anybody new.
    const c = createFallbackCounter({ windowMs: MINUTE, maxKeys: 1 });
    expect(c.increment("a", 0)).toBe(1);
    expect(c.increment("b", 0)).toBeNull();
    expect(c.increment("b", 60_000)).toBe(1);
  });

  it("never grows past the cap, however many keys arrive", () => {
    // The memory bound is the point: an unbounded map keyed by source address is
    // a memory-exhaustion vector, so a fallback that closed a brute-force hole
    // would have opened a worse one.
    const c = createFallbackCounter({ windowMs: MINUTE, maxKeys: 3 });
    for (let i = 0; i < 1_000; i++) c.increment(`ip-${i}`, 0);
    expect(c.size()).toBe(3);
  });
});
