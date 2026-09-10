import { describe, expect, it } from "vitest";

import { bucketsFor, minuteOf, periodOf } from "./meter.js";

const at = (iso: string) => new Date(iso);
const total = (b: Record<string, number>) =>
  Object.values(b).reduce((a, n) => a + n, 0);

describe("bucketsFor — the unit, on a clock the test supplies", () => {
  it("charges a five-second socket one minute", () => {
    expect(bucketsFor(at("2026-08-22T10:00:03Z"), at("2026-08-22T10:00:08Z")))
      .toEqual({ "2026-08-01": 1 });
  });

  it("charges 00:00:59 to 00:01:01 TWO minutes", () => {
    // Two seconds of wall clock. The connection was present in two calendar
    // minutes, and the unit is the minute it was present in.
    expect(bucketsFor(at("2026-01-01T00:00:59Z"), at("2026-01-01T00:01:01Z")))
      .toEqual({ "2026-01-01": 2 });
  });

  it("charges a fresh connection its first minute immediately", () => {
    // Zero would make "just opened" indistinguishable from "never reported".
    const t = at("2026-08-22T10:00:00Z");
    expect(total(bucketsFor(t, t))).toBe(1);
  });

  it("counts every boundary crossed, not the elapsed minutes", () => {
    // Open 10:00:59, now 10:03:01 — 2m02s elapsed, four buckets touched.
    expect(total(bucketsFor(at("2026-08-22T10:00:59Z"), at("2026-08-22T10:03:01Z"))))
      .toBe(4);
  });

  it("charges a thousand five-second sockets a thousand minutes, not eighty-three", () => {
    // The comparison that chose this model. Summing seconds would give
    // 5,000s = 83 minutes and make reconnect churn almost free.
    let minutes = 0;
    for (let i = 0; i < 1000; i++) {
      const open = at(`2026-08-22T10:${String(i % 60).padStart(2, "0")}:03Z`);
      minutes += total(bucketsFor(open, new Date(open.getTime() + 5_000)));
    }
    expect(minutes).toBe(1000);
  });

  it("splits a connection across a month boundary", () => {
    // 23:58:10 to 00:01:40 touches 23:58, 23:59, 00:00 and 00:01 — two buckets
    // in August and two in September, each period credited on its own.
    //
    // The first draft of this test said three and two. Counting boundaries by
    // eye is exactly the arithmetic this function exists to stop anyone doing,
    // and it caught its author first.
    const b = bucketsFor(at("2026-08-31T23:58:10Z"), at("2026-09-01T00:01:40Z"));
    expect(b).toEqual({ "2026-08-01": 2, "2026-09-01": 2 });
    expect(total(b)).toBe(4);
  });

  it("only ever grows, which is what makes a report idempotent", () => {
    const open = at("2026-08-22T10:00:00Z");
    let previous = 0;
    for (const m of [0, 1, 5, 59, 60, 61]) {
      const now = total(bucketsFor(open, new Date(open.getTime() + m * 60_000)));
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });

  it("returns nothing for a clock that has gone backwards", () => {
    // Skew between instances is bounded and real; a negative span is not a
    // credit of -1.
    expect(bucketsFor(at("2026-08-22T10:05:00Z"), at("2026-08-22T10:04:00Z")))
      .toEqual({});
  });
});

describe("the gateway's copy of the calendar", () => {
  it("floors a minute and ignores the seconds", () => {
    expect(minuteOf(at("2026-08-22T14:37:59.999Z"))).toBe("2026-08-22T14:37");
  });

  it("is UTC, not the host's zone", () => {
    expect(periodOf(at("2026-08-31T23:30:00Z"))).toBe("2026-08-01");
    expect(periodOf(at("2026-09-01T00:30:00Z"))).toBe("2026-09-01");
  });
});

// The drift test R18 requires, gateway side. Its twin lives in
// `services/api/src/quotas/period.test.ts` and both hold the SAME instants.
//
// The gateway cannot import the api's `period.ts` — it is another service — so
// the calendar is copied, with the argument `limits.ts` already made for copying
// the window arithmetic. What makes a deliberate duplication different from a
// copy somebody forgot about is that something fails when they diverge. This is
// that something, and feature 030's R50 established the shape.
export const DRIFT_INSTANTS = [
  "2026-01-01T00:00:00Z", "2026-01-01T00:00:59Z", "2026-01-31T23:59:59Z",
  "2026-02-01T00:00:00Z", "2024-02-29T12:00:00Z", "2026-06-15T13:47:22Z",
  "2026-08-31T23:59:30Z", "2026-09-01T00:00:30Z", "2026-12-31T23:59:59Z",
  "2027-01-01T00:00:00Z", "2026-03-01T00:00:00Z", "2026-10-05T09:00:00Z",
];

describe("the two calendars agree (drift test, R18)", () => {
  it("floors every instant to the same period and the same minute", () => {
    // Expected values are written out rather than computed, so that a change to
    // BOTH copies at once still fails here. A drift test that derives its
    // expectation from one of the two things it compares proves nothing.
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
    expect(expected.map(([iso]) => iso)).toEqual(DRIFT_INSTANTS);
    for (const [iso, period, minute] of expected) {
      expect(periodOf(at(iso))).toBe(period);
      expect(minuteOf(at(iso))).toBe(minute);
    }
  });
});
