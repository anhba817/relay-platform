import { describe, expect, it } from "vitest";

import { RETRY_TIERS_MS } from "./schedule";
import {
  DISABLE_AFTER_MS,
  DISABLE_MIN_ATTEMPTS,
  disableReason,
  runWindowMs,
  shouldDisable,
} from "./disable";

// The decision to switch off a paying customer's endpoint (chapter 3.6).
//
// Pinned at 100% branches in `vitest.coverage.config.mts`, because constitution VI
// names idempotency logic and this is the predicate the at-most-once disable rests
// on. It is also the only arithmetic in the chapter, and arithmetic is the kind of
// thing that is obviously right until somebody computes it.

const T0 = new Date("2026-08-18T08:00:00.000Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("shouldDisable requires an hour AND five failures", () => {
  it("disables a run past the hour with five failures", () => {
    expect(
      shouldDisable({
        runStartedAt: T0,
        runAttempts: 5,
        now: after(HOUR + MINUTE),
      }),
    ).toBe(true);
  });

  it("does NOT disable four failures, however long the run", () => {
    // The floor, doing its job. A whole day of a single failing delivery that
    // only ever managed four attempts is not five failures.
    expect(
      shouldDisable({
        runStartedAt: T0,
        runAttempts: DISABLE_MIN_ATTEMPTS - 1,
        now: after(24 * HOUR),
      }),
    ).toBe(false);
  });

  it("does NOT disable five failures inside the hour", () => {
    // The window, doing its job. Chapter 3.5's first five attempts all land
    // within 5m36s, so without the hour a single blip would disable an endpoint
    // six seconds into an outage that might already be over.
    expect(
      shouldDisable({
        runStartedAt: T0,
        runAttempts: 9,
        now: after(HOUR - 1),
      }),
    ).toBe(false);
  });

  it("does not disable at EXACTLY the hour — FR-007 says more than", () => {
    // A boundary worth pinning rather than leaving to whichever comparison
    // somebody typed. "More than an hour" is `>`, and one millisecond later is
    // the first moment that is true.
    const attempts = DISABLE_MIN_ATTEMPTS;
    expect(
      shouldDisable({ runStartedAt: T0, runAttempts: attempts, now: after(HOUR) }),
    ).toBe(false);
    expect(
      shouldDisable({
        runStartedAt: T0,
        runAttempts: attempts,
        now: after(HOUR + 1),
      }),
    ).toBe(true);
  });

  it("treats a healthy endpoint as no candidate at all", () => {
    // Both nulls are how "healthy" is spelled, and each null is checked because a
    // schema CHECK guarantees they agree but this function must not depend on the
    // schema to be correct.
    const now = after(48 * HOUR);
    expect(shouldDisable({ runStartedAt: null, runAttempts: null, now })).toBe(false);
    expect(shouldDisable({ runStartedAt: null, runAttempts: 99, now })).toBe(false);
    expect(shouldDisable({ runStartedAt: T0, runAttempts: null, now })).toBe(false);
  });

  it("does not disable a run of zero length", () => {
    // The first failure opens the run and is evaluated in the same transaction, so
    // this case happens on every single failure. It must be cheap and it must be
    // false.
    expect(shouldDisable({ runStartedAt: T0, runAttempts: 1, now: T0 })).toBe(false);
  });

  it("yields no negative window when the clock moves backwards", () => {
    // An NTP correction, a container resumed from a snapshot, a replica whose
    // clock differs from the writer's. A negative window would compare as "not
    // yet" — the safe direction, but only by accident, and this makes it a
    // property rather than luck. Spec edge case.
    const backwards = new Date(T0.getTime() - 5 * MINUTE);
    expect(runWindowMs({ runStartedAt: T0, now: backwards })).toBe(0);
    expect(
      shouldDisable({ runStartedAt: T0, runAttempts: 99, now: backwards }),
    ).toBe(false);
  });
});

describe("the floor is reachable by one failing delivery (research R3)", () => {
  // THE MEASUREMENT THAT CHOSE THE NUMBER, re-derived here from the real tier
  // table rather than restated. If a later chapter changes the schedule, this
  // fails and the floor gets re-examined — which is the whole reason it is
  // computed from `RETRY_TIERS_MS` instead of written down.
  const attemptOffsets = RETRY_TIERS_MS.reduce<number[]>(
    (acc, tier) => [...acc, (acc.at(-1) ?? 0) + tier],
    [],
  );

  it("reaches the floor inside the hour, with a margin of one attempt", () => {
    // Attempt N lands at offset N-1. The floor is cleared when the attempt at
    // index DISABLE_MIN_ATTEMPTS - 1 is still inside the window.
    const atFloor = attemptOffsets[DISABLE_MIN_ATTEMPTS - 1]!;
    expect(atFloor).toBeLessThan(DISABLE_AFTER_MS);

    // The margin: one more attempt also lands inside the hour.
    const oneMore = attemptOffsets[DISABLE_MIN_ATTEMPTS]!;
    expect(oneMore).toBeLessThan(DISABLE_AFTER_MS);
  });

  it("would be unreachable at a floor of seven, which is why it is not seven", () => {
    // The last attempt falls at +2h35m36s. A floor equal to the attempt count
    // would mean a single failing delivery never disables its endpoint, and the
    // quiet endpoint stays broken for ever — the exact failure research R1 found.
    const lastAttempt = attemptOffsets.at(-1)!;
    expect(lastAttempt).toBeGreaterThan(DISABLE_AFTER_MS);
    expect(attemptOffsets.length).toBeGreaterThan(DISABLE_MIN_ATTEMPTS);
  });

  it("is above the blip threshold: three failures arrive within seconds", () => {
    const third = attemptOffsets[2]!;
    expect(third).toBeLessThan(10_000);
    expect(DISABLE_MIN_ATTEMPTS).toBeGreaterThan(3);
  });
});

describe("disableReason says what happened", () => {
  it("names the count, the window and the last status", () => {
    expect(
      disableReason({
        runAttempts: 6,
        windowMs: HOUR + 4 * MINUTE,
        lastStatus: 503,
        lastError: null,
      }),
    ).toBe("6 consecutive failures over 1h04m; last status 503");
  });

  it("names the error when nothing answered", () => {
    expect(
      disableReason({
        runAttempts: 5,
        windowMs: 2 * HOUR,
        lastStatus: null,
        lastError: "timeout after 10000ms",
      }),
    ).toBe("5 consecutive failures over 2h00m; no response (timeout after 10000ms)");
  });

  it("says `no response` when there is neither", () => {
    // The sweep's case: it disables an endpoint whose failures stopped arriving,
    // and the last delivery may predate the columns that would have recorded them.
    expect(
      disableReason({
        runAttempts: 5,
        windowMs: HOUR + MINUTE,
        lastStatus: null,
        lastError: null,
      }),
    ).toBe("5 consecutive failures over 1h01m; no response");
  });

  it("bounds an enormous error rather than quoting all of it", () => {
    // Spec edge case: "an attempt whose error message is enormous, or contains a
    // customer's payload". This column is read by a person; the full error is
    // already capped at 2000 characters by the seam, and a reason is a sentence.
    const reason = disableReason({
      runAttempts: 5,
      windowMs: 2 * HOUR,
      lastStatus: null,
      lastError: "x".repeat(2000),
    });
    expect(reason.length).toBeLessThan(300);
    expect(reason).toContain("x".repeat(200));
    expect(reason).not.toContain("x".repeat(201));
  });
});
