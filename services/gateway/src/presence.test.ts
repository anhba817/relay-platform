import { describe, expect, it } from "vitest";

import {
  DEFAULT_GRACE_MS,
  DEFAULT_MARGIN_MS,
  DEFAULT_REFRESH_MS,
  DEFAULT_TTL_MS,
  graceCheckDelay,
  wonTransition,
} from "./presence.js";

// PURE LOGIC ONLY, and that is the file's whole shape. `createPresence` builds its
// own Redis clients from a url and cannot be handed a double, so anything
// reply-dependent lives in `presence.itest.ts`. `limits.test.ts` is the precedent:
// it covers `windowStartFor` and `overLimit` and nothing that touches a client.

describe("wonTransition", () => {
  it("is true only for the caller that SET … NX answered", () => {
    expect(wonTransition("OK")).toBe(true);
    expect(wonTransition(null)).toBe(false);
  });
});

describe("the timings", () => {
  it("keeps FR-RTM-06's thirty seconds somewhere a reader can find it", () => {
    // Without this the clause's number lives only in a constant somebody edits.
    expect(DEFAULT_GRACE_MS).toBe(30_000);
  });

  it("refreshes well inside the TTL", () => {
    // A TTL equal to its refresh interval expires a connected user. Three
    // refreshes per TTL survive two consecutive misses.
    expect(DEFAULT_REFRESH_MS).toBeLessThan(DEFAULT_TTL_MS / 2);
  });

  it("checks after the grace ends, never exactly on it", () => {
    // Two deadlines on one instant, reached by two clocks, strand the user online
    // permanently — the check wins the race, finds the key alive, and its one-shot
    // timer is gone (research R2b).
    expect(DEFAULT_MARGIN_MS).toBeGreaterThan(0);
  });

  it("defaults the margin to a second", () => {
    expect(DEFAULT_MARGIN_MS).toBe(1_000);
  });

  it("defaults the TTL to the SAD's thirty seconds", () => {
    expect(DEFAULT_TTL_MS).toBe(30_000);
  });

  // NOT ASSERTED: `ttlMs >= graceMs`. The close re-pins the key, which is what
  // makes the grace correct — the numeric relation is the sane default, not the
  // mechanism, and a test may set the TTL below the grace deliberately to open the
  // gap the reconnect-late case needs.
});

describe("graceCheckDelay", () => {
  it("is the grace plus the margin, never the grace alone", () => {
    expect(graceCheckDelay(30_000, 1_000)).toBe(31_000);
    expect(graceCheckDelay(300, 50)).toBe(350);
  });

  // The whole point of the margin: the check must never land on the instant the
  // re-pinned key expires, because Redis holds a key until `now` is strictly past
  // its expiry and a tie leaves the user online with no timer left to try again.
  it("never returns the grace unchanged", () => {
    expect(graceCheckDelay(30_000, DEFAULT_MARGIN_MS)).toBeGreaterThan(30_000);
  });
});
