import { describe, expect, it } from "vitest";

import { periodOf } from "./period";

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
