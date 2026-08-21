import { describe, expect, it } from "vitest";

import { THRESHOLDS, thresholdsCrossed } from "./policy";

// Which thresholds a usage increase crossed.
//
// Pure arithmetic, no database and no clock, because the send transaction has to
// answer this between an UPDATE and an INSERT and cannot afford to ask anything.

describe("the thresholds an increase crosses", () => {
  it("names the three the requirement names", () => {
    expect(THRESHOLDS).toEqual([50, 80, 100]);
  });

  it("crosses one when usage steps over it", () => {
    expect(thresholdsCrossed(49, 51, 100)).toEqual([50]);
  });

  it("crosses none when it steps between two", () => {
    expect(thresholdsCrossed(81, 82, 100)).toEqual([]);
  });

  it("crosses all three when one send jumps from 40% to 100%", () => {
    // One message can take a tenant from comfortable to suspended, and all three
    // emails are owed. The alternative — notify only the highest — would mean an
    // admin who never learns their 50% warning existed.
    expect(thresholdsCrossed(40, 100, 100)).toEqual([50, 80, 100]);
  });

  it("crosses nothing on a decrease", () => {
    // Usage does not fall inside a period, but a cap can be raised, which moves
    // the percentage down. Nothing is crossed on the way back.
    expect(thresholdsCrossed(90, 40, 100)).toEqual([]);
  });

  it("crosses nothing when usage does not move", () => {
    expect(thresholdsCrossed(50, 50, 100)).toEqual([]);
  });

  it("treats reaching the threshold exactly as crossing it", () => {
    // "at 50%" in FR-014, not "past 50%".
    expect(thresholdsCrossed(49, 50, 100)).toEqual([50]);
    expect(thresholdsCrossed(99, 100, 100)).toEqual([100]);
  });

  it("does not re-cross a threshold already below the starting point", () => {
    expect(thresholdsCrossed(50, 60, 100)).toEqual([]);
    expect(thresholdsCrossed(100, 120, 100)).toEqual([]);
  });

  it("crosses everything at once when the quota is zero", () => {
    // A cap of zero is 100% at usage zero and must stay expressible — an
    // environment can be switched off deliberately (FR-006). Dividing by it is
    // the obvious way to get this wrong.
    expect(thresholdsCrossed(0, 1, 0)).toEqual([50, 80, 100]);
  });

  it("crosses nothing at any usage when the quota is null", () => {
    // Unlimited. The function must say so rather than divide by null — the branch
    // that would otherwise appear as a crash in production and as full coverage
    // in the ratchet, because no test ever asked.
    expect(thresholdsCrossed(0, 1_000_000, null)).toEqual([]);
    expect(thresholdsCrossed(0, 0, null)).toEqual([]);
  });
});
