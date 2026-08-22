import { describe, expect, it } from "vitest";

import { minuteOf, periodOf, periodOfMinute } from "./period";

// The month a usage row belongs to, and the one definition of it.
//
// A quota is about THIS MONTH, so "which month" has to mean exactly one thing in
// the migration's default, the repository's predicate and the relay's read. The
// tests below are what stops it meaning three things.

describe("the period an instant belongs to", () => {
  it("is the first day of its calendar month", () => {
    expect(periodOf(new Date("2026-08-21T13:45:09.123Z"))).toBe("2026-08-01");
  });

  it("includes the first instant of the month", () => {
    expect(periodOf(new Date("2026-08-01T00:00:00.000Z"))).toBe("2026-08-01");
  });

  it("includes the last instant of the month", () => {
    expect(periodOf(new Date("2026-08-31T23:59:59.999Z"))).toBe("2026-08-01");
  });

  it("rolls at midnight UTC on the first, not a moment before", () => {
    expect(periodOf(new Date("2026-08-31T23:59:59.999Z"))).toBe("2026-08-01");
    expect(periodOf(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09-01");
  });

  it("is UTC even when the instant is late evening somewhere east of it", () => {
    // 2026-09-01T05:30 in Kolkata is 2026-08-31T00:00Z — still August. A
    // `date_trunc('month', now())` without `at time zone 'utc'` would answer
    // September on a server whose timezone is ahead, and the row would land in a
    // period the reader never looks in. That failure is silent: nothing errors,
    // the count is just wrong for one tenant on one day a month.
    expect(periodOf(new Date("2026-08-31T22:15:00.000Z"))).toBe("2026-08-01");
    // And the mirror case, west of UTC: 2026-08-31T19:00 in New York is
    // 2026-09-01T23:00Z, which is September.
    expect(periodOf(new Date("2026-09-01T02:30:00.000Z"))).toBe("2026-09-01");
  });

  it("pads single-digit months and returns a plain date string", () => {
    // The column is a `date` and the value is compared as part of a primary key,
    // so `2026-9-01` and `2026-09-01` cannot both be allowed to happen.
    expect(periodOf(new Date("2026-01-15T00:00:00.000Z"))).toBe("2026-01-01");
    expect(periodOf(new Date("2026-09-15T00:00:00.000Z"))).toBe("2026-09-01");
    expect(periodOf(new Date("2026-12-31T12:00:00.000Z"))).toBe("2026-12-01");
  });

  it("handles a leap February", () => {
    expect(periodOf(new Date("2028-02-29T18:00:00.000Z"))).toBe("2028-02-01");
  });
});

describe("minuteOf (chapter 3.11)", () => {
  it("floors to the minute, so a second is not a bucket", () => {
    expect(minuteOf(new Date("2026-08-22T14:37:00.000Z"))).toBe("2026-08-22T14:37");
    expect(minuteOf(new Date("2026-08-22T14:37:59.999Z"))).toBe("2026-08-22T14:37");
  });

  it("crosses at the minute boundary, which is what makes a 2s socket cost two", () => {
    // The chapter's own example. Open at 00:00:59, closed at 00:01:01: two
    // seconds of wall clock, two buckets, two connection-minutes.
    expect(minuteOf(new Date("2026-01-01T00:00:59Z"))).toBe("2026-01-01T00:00");
    expect(minuteOf(new Date("2026-01-01T00:01:01Z"))).toBe("2026-01-01T00:01");
  });

  it("is UTC, not local — the same argument periodOf makes", () => {
    // 23:30 UTC on the 31st is the next day in Asia/Ho_Chi_Minh. A bucket that
    // followed the server's zone would land a tenant's minutes in a period
    // nobody reads, which is the failure periodOf's comment describes.
    expect(minuteOf(new Date("2026-08-31T23:30:00Z"))).toBe("2026-08-31T23:30");
  });

  it("sorts lexically in the order it sorts chronologically", () => {
    const shuffled = [
      "2026-08-22T09:05", "2026-08-09T22:05", "2026-08-22T09:00",
    ].sort();
    expect(shuffled).toEqual([
      "2026-08-09T22:05", "2026-08-22T09:00", "2026-08-22T09:05",
    ]);
  });
});

describe("periodOfMinute agrees with periodOf (chapter 3.11)", () => {
  it("maps a bucket to the period its instant belongs to", () => {
    for (const iso of [
      "2026-01-01T00:00:00Z", "2026-08-22T14:37:12Z",
      "2026-12-31T23:59:59Z", "2024-02-29T12:00:00Z",
    ]) {
      const at = new Date(iso);
      expect(periodOfMinute(minuteOf(at))).toBe(periodOf(at));
    }
  });

  it("puts the two sides of a month boundary in different periods", () => {
    const before = new Date("2026-08-31T23:59:30Z");
    const after = new Date("2026-09-01T00:00:30Z");
    expect(periodOfMinute(minuteOf(before))).toBe("2026-08-01");
    expect(periodOfMinute(minuteOf(after))).toBe("2026-09-01");
  });
});

// The drift test R18 requires, api side. Its twin is in
// `services/gateway/src/meter.test.ts` and both hold the SAME instants and the
// SAME written-out expectations. The gateway keeps its own copy of this calendar
// because it cannot import across a service boundary; a period that disagreed
// between the two would put a tenant's minutes in a month nobody reads.
describe("the two calendars agree (drift test, R18)", () => {
  it("floors every instant to the same period and the same minute", () => {
    const expected: Array<[string, string, string]> = [
      ["2026-01-01T00:00:00Z", "2026-01-01", "2026-01-01T00:00"],
      ["2026-01-01T00:00:59Z", "2026-01-01", "2026-01-01T00:00"],
      ["2026-01-31T23:59:59Z", "2026-01-01", "2026-01-31T23:59"],
      ["2026-02-01T00:00:00Z", "2026-02-01", "2026-02-01T00:00"],
      ["2024-02-29T12:00:00Z", "2024-02-01", "2024-02-29T12:00"],
      ["2026-06-15T13:47:22Z", "2026-06-01", "2026-06-15T13:47"],
      ["2026-08-31T23:59:30Z", "2026-08-01", "2026-08-31T23:59"],
      ["2026-09-01T00:00:30Z", "2026-09-01", "2026-09-01T00:00"],
      ["2026-12-31T23:59:59Z", "2026-12-01", "2026-12-31T23:59"],
      ["2027-01-01T00:00:00Z", "2027-01-01", "2027-01-01T00:00"],
      ["2026-03-01T00:00:00Z", "2026-03-01", "2026-03-01T00:00"],
      ["2026-10-05T09:00:00Z", "2026-10-01", "2026-10-05T09:00"],
    ];
    for (const [iso, period, minute] of expected) {
      expect(periodOf(new Date(iso))).toBe(period);
      expect(minuteOf(new Date(iso))).toBe(minute);
    }
  });
});
