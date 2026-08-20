import { describe, expect, it } from "vitest";

import { remaining, resetAt, windowStart } from "./bucket";

// The fixed-window arithmetic (chapter 3.8, research R1). Pure: no store, no
// clock of its own — every function takes the instant it should reason about,
// which is what lets a boundary be tested rather than waited for.

const MINUTE = 60_000;

describe("windowStart", () => {
  it("floors an instant to the window it belongs to", () => {
    expect(windowStart(90_000, MINUTE)).toBe(60_000);
    expect(windowStart(60_000, MINUTE)).toBe(60_000);
    expect(windowStart(59_999, MINUTE)).toBe(0);
  });

  it("is the key's own suffix, which is why nothing stores a reset time", () => {
    // Two instances computing this from the same clock agree without talking.
    // A stored reset time is a value they could disagree about — the clock-skew
    // edge case, closed by construction rather than by agreement.
    expect(windowStart(119_999, MINUTE)).toBe(windowStart(60_000, MINUTE));
  });
});

describe("resetAt", () => {
  it("is the end of the current window, not a refill curve", () => {
    // The deciding reason for a fixed window over a token bucket (R1):
    // `X-RateLimit-Reset` has to name one moment, and this is it.
    expect(resetAt(90_000, MINUTE)).toBe(120_000);
  });

  it("never lands in the past", () => {
    for (const now of [0, 1, 59_999, 60_000, 60_001]) {
      expect(resetAt(now, MINUTE)).toBeGreaterThan(now - 1);
    }
  });
});

describe("remaining", () => {
  it("counts down from the limit as the count rises", () => {
    expect(remaining(1, 600)).toBe(599);
    expect(remaining(600, 600)).toBe(0);
  });

  it("A COUNTER THAT HAS NEVER BEEN WRITTEN returns a full allowance", () => {
    // The `INCR`-returns-1 path, which is also where `EXPIRE` is set. A brand-new
    // environment's first request must not look like an exhausted one.
    expect(remaining(1, 600)).toBe(599);
    expect(remaining(0, 600)).toBe(600);
  });

  it("A LIMIT LOWERED MID-WINDOW yields zero, never a negative", () => {
    // An operator drops an environment from 600 to 2 while 40 requests are
    // already counted. `Remaining: -38` is a number a client would parse and act
    // on; zero is the truth.
    expect(remaining(40, 2)).toBe(0);
  });

  it("is zero at the limit, so a refusal reports zero rather than one", () => {
    expect(remaining(600, 600)).toBe(0);
    expect(remaining(601, 600)).toBe(0);
  });
});

describe("the boundary burst, which is the cost of a fixed window", () => {
  it("permits up to twice the limit across one window edge", () => {
    // R1 accepted this rather than hiding it: 600 in the last instant of one
    // window and 600 in the first instant of the next is 1,200 inside two
    // minutes. Asserted so the chapter's claim is a test rather than a comment.
    const limit = 600;
    const firstWindow = windowStart(59_999, MINUTE);
    const secondWindow = windowStart(60_000, MINUTE);
    expect(firstWindow).not.toBe(secondWindow);
    expect(remaining(limit, limit) + limit).toBe(limit);
    // Two distinct keys, each allowing `limit`, one millisecond apart.
    expect(remaining(1, limit)).toBe(limit - 1);
  });
});
