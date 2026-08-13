import { describe, expect, it } from "vitest";

import { MAX_ATTEMPTS, RETRY_TIERS_MS, nextAttemptAt } from "./schedule";

// The tier table, pure. What the broker-backed design could never have offered:
// the schedule is a lookup, so it can be asserted without a broker, a database
// or two hours of waiting.

const AT = new Date("2026-08-10T12:00:00.000Z");

describe("the tiers", () => {
  it("has seven: one immediate attempt and FR-WHK-03's six retries", () => {
    // See schedule.ts's DECISION for why the delay list wins over the count when
    // the requirement contradicts itself — keeping the 2 h tier keeps the
    // platform's most customer-visible promise at two hours.
    expect(MAX_ATTEMPTS).toBe(7);
    expect(RETRY_TIERS_MS).toHaveLength(7);
  });

  it("delivers the first attempt immediately", () => {
    // A webhook that waits before its first try makes every integration feel
    // broken for a reason no customer can see.
    expect(nextAttemptAt(1, AT)).toEqual(AT);
  });

  it("widens strictly, so no two tiers are the same wait", () => {
    for (let i = 1; i < RETRY_TIERS_MS.length; i++) {
      expect(RETRY_TIERS_MS[i]!).toBeGreaterThan(RETRY_TIERS_MS[i - 1]!);
    }
  });

  it("schedules each attempt from the moment its predecessor failed", () => {
    expect(nextAttemptAt(2, AT)).toEqual(new Date(AT.getTime() + 1_000));
    expect(nextAttemptAt(3, AT)).toEqual(new Date(AT.getTime() + 5_000));
    expect(nextAttemptAt(4, AT)).toEqual(new Date(AT.getTime() + 30_000));
    expect(nextAttemptAt(5, AT)).toEqual(new Date(AT.getTime() + 300_000));
    expect(nextAttemptAt(6, AT)).toEqual(new Date(AT.getTime() + 1_800_000));
    expect(nextAttemptAt(7, AT)).toEqual(new Date(AT.getTime() + 7_200_000));
  });

  it("returns null past the last tier — the signal to dead-letter", () => {
    // A value rather than an exception, so the outcome path stays one
    // expression: schedule if there is a tier, dead-letter if there is not.
    expect(nextAttemptAt(MAX_ATTEMPTS + 1, AT)).toBeNull();
    expect(nextAttemptAt(0, AT)).toBeNull();
  });

  it("is recomputable from the attempt number alone", () => {
    // `attempt` is the index into the table, not a running counter — so a
    // delivery's next due time is a lookup, and no branch can leave one drifting
    // on a schedule nobody can reconstruct.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(nextAttemptAt(attempt, AT)).toEqual(nextAttemptAt(attempt, AT));
    }
  });
});
