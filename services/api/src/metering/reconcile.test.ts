import { describe, expect, it } from "vitest";

import {
  RECONCILE_THRESHOLD,
  differencePct,
  exitCodeFor,
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
