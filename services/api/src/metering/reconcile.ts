// FR-ANL-06's comparison, as arithmetic over two numbers.
//
// *"Metered totals shall agree with counts derived from operational data to within 0.1%,
// verified by a daily reconciliation job that raises an alert on breach."*
//
// THIS FILE IS THE HALF THAT RUNS WITHOUT A STORE, AND `docs/12` §2.3 IS WHY. The lane's
// largest membership set is five channels, and *"0.1% of a small number is an assertion that
// cannot fail for its own reason"* — so the milestone splits into a planted drift the lane
// checks every run, and the 0.1% figure measured once at a volume where it means something.
// Separating the verdict from the gathering is what lets the first half run with no corpus,
// no database and no broker.

/** The threshold FR-ANL-06 names. A constant with its clause beside it, because a bare
 *  `0.001` in an expression is a number somebody later adjusts to make a test pass. */
export const RECONCILE_THRESHOLD = 0.001; // 0.1%, SRS FR-ANL-06

export type Verdict = "pass" | "breach" | "not-comparable" | "no-data";

export interface Comparison {
  /** Rollup total, or null when the analytical side holds nothing for this tenant-period. */
  analytical: number | null;
  /** Operational total, or null when Postgres holds nothing for it. */
  operational: number | null;
  /** Does this quantity have an operational counterpart AT ALL?
   *
   * DISTINCT FROM `operational === null`, and the difference is the point. A tenant with no
   * `usage_periods` row has a null total and a source that exists; **the stored message count
   * has no operational source anywhere in this platform** and never will until somebody adds
   * one. Collapsing the two would blame the analytical path for a column Postgres has never
   * had. */
  hasOperationalSource: boolean;
}

/** The verdict, decided from PRESENCE before any arithmetic runs.
 *
 * That ordering is deliberate: only a comparison with both sides present reaches a division,
 * which is what stops a zero denominator from being a case anyone has to think about. */
export function verdictFor(c: Comparison, threshold = RECONCILE_THRESHOLD): Verdict {
  if (!c.hasOperationalSource) return "not-comparable";
  if (c.analytical === null && c.operational === null) return "no-data";
  // ONE-SIDED IS A BREACH, IN EITHER DIRECTION.
  //
  // Measured at this chapter's opening: 675 environments have operational usage rows and
  // ZERO real ones have analytical rollup data, so every tenant in this platform is in the
  // first state. Calling that "missing data" would let the defect this movement exists to
  // expose read as an absence of evidence.
  //
  // And the other direction is not hypothetical either: the analytical store held four
  // environment ids that exist in no Postgres row, because it is fed by a stream and nothing
  // carries a foreign key across the boundary.
  if (c.analytical === null || c.operational === null) return "breach";
  const pct = differencePct(c);
  return pct !== null && pct <= threshold ? "pass" : "breach";
}

/** The difference as a fraction, or null when either side is absent.
 *
 * NULL RATHER THAN ZERO WHEN A SIDE IS MISSING. A number computed against an absent
 * counterpart reads as a measurement and is not one.
 *
 * `max(a, o)` AND NOT THE OPERATIONAL SIDE as the denominator: a tenant can hold analytical
 * rows for a quantity whose operational total is zero, and dividing by that is a crash where
 * a verdict belongs.
 *
 * AND BOTH-ZERO IS AGREEMENT, NOT A DIVISION. Two present sides that both read zero make the
 * denominator zero too. This case is reachable — `usage_periods` holds 288 rows for 2026-08
 * with `messages_sent = 0` — and it was not in the design: `data-model.md` specified the
 * formula and the verdict ordering and never said what `0 / 0` means. It means they agree. */
export function differencePct(c: Comparison): number | null {
  if (c.analytical === null || c.operational === null) return null;
  const denominator = Math.max(c.analytical, c.operational);
  if (denominator === 0) return 0;
  return Math.abs(c.analytical - c.operational) / denominator;
}
