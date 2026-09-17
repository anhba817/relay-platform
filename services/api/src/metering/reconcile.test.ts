import { describe, expect, it } from "vitest";

import {
  RECONCILE_THRESHOLD,
  assertEnvironmentId,
  assertPeriod,
  differencePct,
  exitCodeFor,
  smallestExpressibleDrift,
  verdictFor,
  type Comparison,
  type ReconcileRow,
  type Verdict,
} from "./reconcile";

// THE VERDICT, WITH NO STORE IN SIGHT.
//
// `docs/12` §2.3 splits FR-ANL-06's milestone in two, and the reason is this file's whole
// justification: *"the lane's largest membership set is five channels; 0.1% of a small number
// is an assertion that cannot fail for its own reason."* So the lane checks that a planted
// drift is DETECTED, and the 0.1% figure is measured once at a volume where it means
// something. Detection is arithmetic, and arithmetic needs no corpus.

const both = (analytical: number, operational: number): Comparison => ({
  analytical,
  operational,
  hasOperationalSource: true,
});

describe("the verdict is decided from presence, before any arithmetic", () => {
  it("calls a quantity with no operational source not-comparable, however much data it has", () => {
    // The stored message count is in this state permanently: `usage_periods` carries
    // `messages_sent` and `connection_minutes`, `usage_active_users` carries the third, and
    // nothing anywhere carries a stored total. Reporting that as a breach would blame the
    // analytical path for a column Postgres has never had.
    expect(
      verdictFor({ analytical: 5_000, operational: null, hasOperationalSource: false }),
    ).toBe("not-comparable");
    expect(
      verdictFor({ analytical: null, operational: null, hasOperationalSource: false }),
    ).toBe("not-comparable");
  });

  it("calls both sides absent no-data, because zero against zero is not agreement", () => {
    expect(
      verdictFor({ analytical: null, operational: null, hasOperationalSource: true }),
    ).toBe("no-data");
  });

  it("calls one side absent a breach, in BOTH directions", () => {
    // Operational-only is every tenant in this platform: 675 environments with usage rows
    // and zero with analytical rollup data.
    expect(
      verdictFor({ analytical: null, operational: 9_624, hasOperationalSource: true }),
    ).toBe("breach");
    // Analytical-only is not hypothetical either — the store held four environment ids that
    // exist in no Postgres row, because a stream carries no foreign key.
    expect(
      verdictFor({ analytical: 40, operational: null, hasOperationalSource: true }),
    ).toBe("breach");
  });
});

describe("the tolerance boundary, from both sides", () => {
  it("passes a difference just under the threshold", () => {
    // 100,000 against 100,090 is 0.09%, inside 0.1%.
    expect(verdictFor(both(100_000, 100_090))).toBe("pass");
  });

  it("breaches a difference just over it", () => {
    // 100,000 against 100,110 is 0.1099%, outside.
    expect(verdictFor(both(100_000, 100_110))).toBe("breach");
  });

  it("passes exactly at the threshold, because the clause says WITHIN 0.1%", () => {
    // THE DENOMINATOR IS `max(a, o)`, WHICH MAKES THE THRESHOLD ASYMMETRIC IN THE NAIVE
    // READING. A first version of this test used 100,000 against 100,100 — "0.1% of 100,000
    // is 100" — and it measured 0.0999%, because the divisor is the larger side. The pair
    // that lands exactly on the bound is 99,900 against 100,000: 100 / 100,000.
    //
    // So a 0.1% shortfall and a 0.1% excess are different absolute amounts, and anyone
    // writing a drift by arithmetic on the smaller side lands just inside the bound.
    const c = both(99_900, 100_000);
    expect(differencePct(c)).toBeCloseTo(RECONCILE_THRESHOLD, 12);
    expect(verdictFor(c)).toBe("pass");
  });

  it("puts a drift computed off the SMALLER side just inside the bound", () => {
    // The mistake above, asserted rather than only commented, because it is the one an
    // implementer planting a drift will make.
    expect(differencePct(both(100_000, 100_100))).toBeLessThan(RECONCILE_THRESHOLD);
    expect(verdictFor(both(100_000, 100_100))).toBe("pass");
  });

  it("agrees exactly when the two sides are equal", () => {
    expect(differencePct(both(9_624, 9_624))).toBe(0);
    expect(verdictFor(both(9_624, 9_624))).toBe("pass");
  });
});

describe("the percentage", () => {
  it("is null whenever either side is absent, rather than zero", () => {
    // A number computed against an absent counterpart reads as a measurement and is not one.
    expect(differencePct({ analytical: null, operational: 10, hasOperationalSource: true }))
      .toBeNull();
    expect(differencePct({ analytical: 10, operational: null, hasOperationalSource: true }))
      .toBeNull();
  });

  it("divides by the LARGER side, so a zero operational total is not a crash", () => {
    // A tenant can hold analytical rows for a quantity whose operational total is zero —
    // `usage_periods` holds 288 rows for 2026-08 with `messages_sent = 0`.
    expect(differencePct(both(40, 0))).toBe(1);
    expect(verdictFor(both(40, 0))).toBe("breach");
  });

  it("calls two present zeroes agreement rather than dividing by nothing", () => {
    // Reachable, and it was not in the design: `data-model.md` gave the formula and the
    // verdict ordering and never said what `0 / 0` means. It means they agree.
    expect(differencePct(both(0, 0))).toBe(0);
    expect(verdictFor(both(0, 0))).toBe("pass");
  });
});

describe("the threshold is a named constant", () => {
  it("is 0.1%, the figure FR-ANL-06 states", () => {
    expect(RECONCILE_THRESHOLD).toBe(0.001);
  });

  it("is overridable, so a test can drive the boundary without editing the clause", () => {
    expect(verdictFor(both(100, 110), 0.2)).toBe("pass");
    expect(verdictFor(both(100, 110), 0.05)).toBe("breach");
  });
});

describe("the exit code is FR-ANL-06's alert, and it is a value rather than a printed line", () => {
  // THIS RULE USED TO LIVE IN `scripts/reconcile-usage.mjs`, in one expression no lane runs.
  // The script still owns the printing; the decision is here, where these four cases reach it.
  const row = (quantity: string, verdict: Verdict): ReconcileRow =>
    ({ quantity, verdict }) as unknown as ReconcileRow;

  it("is 1 when any quantity breaches, whatever the others say", () => {
    expect(exitCodeFor([row("messages", "pass"), row("connectionMinutes", "breach")])).toBe(1);
  });

  it("is 0 for a report with no breach in it", () => {
    expect(exitCodeFor([row("messages", "pass"), row("activeUsers", "pass")])).toBe(0);
  });

  it("does NOT raise on not-comparable or no-data", () => {
    // Every real tenant in this platform is in one of those two states today, and a job that
    // exits 1 every day is one nobody reads. The gap belongs to the chapter, not to this code.
    expect(exitCodeFor([row("storedMessages", "not-comparable"), row("messages", "no-data")])).toBe(
      0,
    );
  });

  it("is 0 for an empty report, because nothing was compared", () => {
    expect(exitCodeFor([])).toBe(0);
  });
});

describe("the smallest drift a volume can express (chapter 4.9, FR-007)", () => {
  // WHAT THE PERCENTAGE MEANS AT A SIZE. Every assertion here also drives `verdictFor`, so
  // the number is checked against the comparison it is about rather than against a formula
  // restated in the test — which is how a test and its subject can agree and both be wrong.
  const drives = (volume: number, d: number, direction: -1 | 1): void => {
    const c = {
      analytical: volume + direction * d,
      operational: volume,
      hasOperationalSource: true as const,
    };
    expect(verdictFor(c)).toBe("breach");
    if (d > 1) {
      expect(
        verdictFor({ ...c, analytical: volume + direction * (d - 1) }),
      ).toBe("pass");
    }
  };

  it("is one whole message below a thousand, which is what 0.1% cannot say there", () => {
    // At nine connection-minutes the smallest drift there IS is 11.11% — a hundred times the
    // bound. A green 0.1% assertion at that volume claims nothing drifted at all.
    expect(smallestExpressibleDrift(9)).toEqual({ under: 1, over: 1 });
    expect(smallestExpressibleDrift(100)).toEqual({ under: 1, over: 1 });
    drives(9, 1, -1);
    drives(100, 1, 1);
  });

  it("first resolves at ten thousand and is comfortable at a hundred thousand", () => {
    expect(smallestExpressibleDrift(1_000)).toEqual({ under: 2, over: 2 });
    expect(smallestExpressibleDrift(10_000)).toEqual({ under: 11, over: 11 });
    expect(smallestExpressibleDrift(100_000)).toEqual({ under: 101, over: 101 });
    // Chapter 4.7's published pair, driven through the comparison in both directions.
    drives(100_000, 101, -1);
    drives(100_000, 101, 1);
  });

  it("says two at the lane's largest tenant-period, which is twice the bound", () => {
    // 1,017 messages: one message is 0.098% and two is 0.197%. This is the number that makes
    // the measurement need a corpus rather than the lane.
    expect(smallestExpressibleDrift(1_017)).toEqual({ under: 2, over: 2 });
  });

  it("gives the two directions DIFFERENT answers, which five measured volumes did not", () => {
    // `max(analytical, operational)` is the denominator, so a surplus of `d` divides by
    // `volume + d` and a shortfall by `volume`. At 999 a surplus of one message PASSES and a
    // shortfall of one BREACHES — and 999 is eighteen below the lane's largest tenant-period,
    // one below a row of the table this feature re-derived, and the first volume where the
    // two differ at all.
    expect(smallestExpressibleDrift(999)).toEqual({ under: 1, over: 2 });
    expect(verdictFor({ analytical: 1_000, operational: 999, hasOperationalSource: true })).toBe(
      "pass",
    );
    expect(verdictFor({ analytical: 998, operational: 999, hasOperationalSource: true })).toBe(
      "breach",
    );
    // And above a million every volume differs.
    expect(smallestExpressibleDrift(1_000_000)).toEqual({ under: 1_001, over: 1_002 });
  });

  it("has no under-direction at zero, because nothing can be short of nothing", () => {
    // Reachable: `usage_periods` holds 288 rows for 2026-08 with `messages_sent = 0`.
    expect(smallestExpressibleDrift(0)).toEqual({ under: null, over: 1 });
  });

  it("takes the threshold, so a chapter can show what a different bound would cost", () => {
    expect(smallestExpressibleDrift(1_000, 0.01)).toEqual({ under: 11, over: 11 });
  });

  it("refuses a volume that is not a count", () => {
    // A fractional volume reaching here means the caller is holding something other than a
    // row count, and the figure it is about to print would be about that instead.
    expect(() => smallestExpressibleDrift(1_017.5)).toThrow(/non-negative integer/);
    expect(() => smallestExpressibleDrift(-1)).toThrow(/non-negative integer/);
  });
});

describe("the two values that reach a ClickHouse statement (chapter 4.9, FR-006c)", () => {
  // MEASURED, NOT ASSUMED: scoped to one tenant and one month the reconciler's rollup read
  // returns 208 rows honestly and 11,895 — the whole table, every tenant — under
  // `2026-09-01') OR 1=1 --`. `toUUID()` and `toDate()` never see it: the quote closes first.
  it("accepts the values the platform itself produces", () => {
    expect(assertEnvironmentId("6f1b2c3d-4e5a-4b7c-8d9e-0f1a2b3c4d5e")).toBe(
      "6f1b2c3d-4e5a-4b7c-8d9e-0f1a2b3c4d5e",
    );
    expect(assertPeriod("2026-09-01")).toBe("2026-09-01");
  });

  it("refuses an environment id carrying a quote", () => {
    expect(() => assertEnvironmentId("6f1b2c3d-4e5a-4b7c-8d9e-0f1a2b3c4d5e') OR 1=1 --")).toThrow(
      /must be a UUID/,
    );
    expect(() => assertEnvironmentId("")).toThrow(/must be a UUID/);
  });

  it("refuses a period carrying a quote, which nine analysis passes did not check", () => {
    expect(() => assertPeriod("2026-09-01') OR 1=1 --")).toThrow(/must be YYYY-MM-01/);
    // A period that is not the first of a month is refused too: the rollup is keyed by day
    // and the half-open range is built from `nextPeriod`, so a mid-month value would ask a
    // question the report's own heading does not describe.
    expect(() => assertPeriod("2026-09-15")).toThrow(/must be YYYY-MM-01/);
  });
});
