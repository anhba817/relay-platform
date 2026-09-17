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

/** The smallest drift a volume can express, in whole units, in each direction.
 *
 * WHAT A PERCENTAGE MEANS AT A GIVEN SIZE. `usage_periods.messages_sent` is a count, so a
 * drift is a whole number of messages; below some volume the smallest drift there IS already
 * breaches, and a green 0.1% assertion at that size claims nothing drifted at all. The lane's
 * largest tenant-period holds 1,017 messages, where one message is 0.098% and two is 0.197% —
 * twice the bound. **A figure published without its volume is the assertion that cannot fail**,
 * and this function is what the harness prints beside every figure so it cannot be.
 *
 * DERIVED FROM `differencePct` RATHER THAN RESTATED. The closed form is
 * `floor(volume × threshold) + 1` in one direction and `floor(volume × threshold / (1 −
 * threshold)) + 1` in the other, and writing either here would be a second copy of the rule
 * `verdictFor` applies — the shape chapter 4.6 found when two files each carried the same
 * month arithmetic. The search asks the real comparison and stops at the first breach, which
 * costs `threshold × volume + 2` iterations.
 *
 * AND THE TWO DIRECTIONS ARE NOT THE SAME NUMBER, WHICH FIVE MEASURED VOLUMES SAID THEY WERE.
 * `max(analytical, operational)` is the denominator, so an excess of `d` divides by
 * `volume + d` and a shortfall by `volume` — the excess is always the harder one to breach.
 * Chapter 4.7 published *"the smallest breaching drift is 101 in both directions"* and this
 * feature's own phase 1 re-derived the table and found over and under equal at 9, 100, 1,000,
 * 10,000, 100,000 and the lane's 1,017. All six land on the agreeing side by luck:
 *
 *     volume        under   over
 *        999            1      2     the first volume where they differ
 *      1,000            2      2
 *      1,017            2      2     the lane's largest tenant-period
 *  1,000,000        1,001  1,002     and every volume above a million differs
 *
 * **500,500 of the volumes below a million differ** — half of them. At 999 a surplus of one
 * message passes and a shortfall of one breaches, which is the sentence the six-row table
 * could not have produced.
 *
 * `under` IS NULL AT ZERO because nothing can be short of nothing, and that state is
 * reachable: `usage_periods` holds 288 rows for 2026-08 with `messages_sent = 0`. */
export interface SmallestDrift {
  /** The analytical side SHORT by this many — `analytical = volume - under`. Null at
   *  volume 0. */
  under: number | null;
  /** The analytical side OVER by this many — `analytical = volume + over`. */
  over: number;
}

export function smallestExpressibleDrift(
  volume: number,
  threshold = RECONCILE_THRESHOLD,
): SmallestDrift {
  // A COUNT, AND THE REFUSAL IS THE POINT. A fractional or negative volume reaching here
  // means the caller is holding something other than a row count, and the figure it is about
  // to print would be about that instead.
  if (!Number.isInteger(volume) || volume < 0) {
    throw new RangeError(`volume must be a non-negative integer, got ${volume}`);
  }
  const breaches = (analytical: number): boolean => {
    const pct = differencePct({ analytical, operational: volume, hasOperationalSource: true });
    return pct !== null && pct > threshold;
  };
  const seek = (direction: 1 | -1): number => {
    let d = 1;
    while (!breaches(volume + direction * d)) d += 1;
    return d;
  };
  return { under: volume === 0 ? null : seek(-1), over: seek(1) };
}

// ---------------------------------------------------------------------------
// THE GATHERING (chapter 4.7, phase 3).
//
// Everything above is arithmetic and runs with no store. Everything below reads both of
// them, which is the thing FR-ANL-06 asks for and constitution III's first sentence appears
// to forbid — see the chapter, and `gaps.md`.
// ---------------------------------------------------------------------------

import type { Db } from "../db/client";
import { operationalUsageFor } from "../db/usage-reads";
import { nextPeriod } from "../quotas/period";
import type { AnalyticalStore } from "./clickhouse";

/** The four quantities FR-ANL-05 names. */
export type Quantity =
  | "messages"
  | "activeUsers"
  | "connectionMinutes"
  | "storedMessages";

export interface ReconcileRow {
  environmentId: string;
  period: string;
  quantity: Quantity;
  analytical: number | null;
  operational: number | null;
  /** WHICH TABLE, NAMED IN THE REPORT. Two operational candidates exist for messages and the
   *  clause chooses neither, so a report that does not say which one it read is asserting the
   *  other does not exist. */
  operationalSource: string | null;
  differencePct: number | null;
  verdict: Verdict;
}

const DB_ANALYTICS = "relay_analytics";

// THE TWO VALUES THAT REACH A CLICKHOUSE STATEMENT, AND BOTH ARE CHECKED BEFORE ONE IS BUILT.
//
// The statements below interpolate `toUUID('${environmentId}')` and `toDate('${period}')`, and
// `scripts/reconcile-usage.mjs` produces both from `process.argv` with no checks at all.
// **`toUUID()` and `toDate()` are not guards**: an injection closes the quote before either
// function is reached. Asked of the real store, scoped to one tenant and one month:
//
//     the honest period                    208 rows
//     2026-09-01') OR 1=1 --            11,895 rows      every tenant, every month
//
// CHECKED HERE RATHER THAN IN THE SCRIPT, which is where the first design put it. A guard on
// the caller protects that caller; a guard on the function protects every caller there will
// ever be, and this one is exported so the script can refuse the value at parse time and name
// the flag. One rule, two call sites, one implementation.
//
// **AND THE COUNT CAME FROM READING THE STATEMENTS, NOT FROM LISTING THE VALUES ALREADY KNOWN.**
// Nine analysis passes checked the environment id and none checked the period, because the
// question asked was *"which value reaches SQL?"* rather than *"which values do?"*
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_PATTERN = /^\d{4}-\d{2}-01$/;

export function assertEnvironmentId(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(
      `environment id must be a UUID, got ${JSON.stringify(value)} — it is interpolated ` +
        `into an analytical statement, where toUUID() is not a guard`,
    );
  }
  return value;
}

/** A period is the first day of a calendar month, as `quotas/period.ts` produces it.
 *
 * WHAT THIS PATTERN DOES NOT CATCH: a month of 13. `toDate('2026-13-01')` is refused by the
 * server, so the value is safe and the message is worse than it needs to be — recorded rather
 * than fixed, because the check's job here is that nothing unvalidated reaches a statement.
 *
 * `until` NEEDS NO CHECK AND IS SAFE BY ACCIDENT, WHICH IS WORTH SAYING OUT LOUD. It is
 * `nextPeriod(period)`, which splits on `-`, maps through `Number` and rebuilds — so anything
 * that got past this check as a period still comes back as digits or as `NaN-NaN-01`, which the
 * server rejects. Safe because of how the arithmetic is written, not because anyone chose it. */
export function assertPeriod(value: string): string {
  if (!PERIOD_PATTERN.test(value)) {
    throw new Error(
      `period must be YYYY-MM-01, got ${JSON.stringify(value)} — it is interpolated into ` +
        `an analytical statement, where toDate() is not a guard`,
    );
  }
  return value;
}

/** FR-ANL-06's comparison, for ONE tenant and ONE period.
 *
 * ONE TENANT PER CALL, AND THAT IS A CONSTRAINT RATHER THAN A CONVENIENCE. Measured at this
 * chapter's opening: aggregated across tenants the two operational counters differ by
 * 0.2694% — a number nobody would question — while 19 tenants breach and one is wrong by
 * everything it has. A sweep is a loop in the caller, and the caller is where a summary
 * belongs.
 *
 * IT WRITES NOTHING. Two invocations with the same arguments return the same report. */
export async function reconcile(
  db: Db,
  store: AnalyticalStore,
  { environmentId, period }: { environmentId: string; period: string },
): Promise<ReconcileRow[]> {
  assertEnvironmentId(environmentId);
  assertPeriod(period);
  // THE DAY RANGE IS HALF-OPEN, and the other spelling is wrong by one day. The caller passes
  // a month — `periodOf`'s `YYYY-MM-01` — and the rollup is keyed by day, so
  // `day >= period AND day < nextPeriod(period)`. `BETWEEN period AND nextPeriod(period)`
  // puts 1 September into August, and **a reconciler's off-by-one does not crash: it reports
  // drift.**
  const until = nextPeriod(period);

  // `count()` FIRST, AND IT IS NOT DECORATION. **A bare aggregate with no GROUP BY always
  // returns exactly one row** — chapter 4.6 established that against the server and used it
  // to delete a guard, and here the same fact means an empty result set is not reachable: a
  // tenant with no rollup rows comes back as `0`, not as nothing. Without the count, "holds
  // nothing" and "holds zero" are the same answer, and this report's whole point is that they
  // are not.
  const rollup = await store.query(
    `SELECT count(), sum(messages), uniqMerge(active_users_state), sum(connection_minutes)
       FROM ${DB_ANALYTICS}.daily_usage_billing
      WHERE environment_id = toUUID('${environmentId}')
        AND day >= toDate('${period}') AND day < toDate('${until}')
      FORMAT TSV`,
  );
  // THE STORED COUNT IS A BALANCE, so it sums every delta up to the period's end rather than
  // within it. A `BETWEEN` here reports the period's CHANGE in stored messages, which is a
  // different question that reads as a plausible wrong answer.
  const stored = await store.query(
    `SELECT count(), sum(stored_delta) FROM ${DB_ANALYTICS}.daily_usage_billing
      WHERE environment_id = toUUID('${environmentId}') AND day < toDate('${until}')
      FORMAT TSV`,
  );

  // THE OPERATIONAL READ GOES THROUGH `db/usage-reads`, NOT THROUGH SQL HERE.
  // `eslint.config.mjs` restricts `drizzle-orm` to `services/api/src/db/**` — "the query
  // engine lives inside the repository layer only (constitution I, ADR-16)" — and the first
  // version of this file failed lint on exactly that import.
  const op = await operationalUsageFor(db, environmentId, period);

  const rollupRow = rollup[0];

  /** An analytical cell, absent when the tenant-period has no rollup rows at all.
   *
   *  THE COUNT DECIDES, NOT THE SUM. A first version read `rollup[0] === undefined` and never
   *  fired: the server answers a bare aggregate with one row whatever the filter matches, so
   *  every empty tenant reported `0` and every `no-data` verdict came back `breach`. */
  const rows0 = rollupRow === undefined ? 0 : Number(rollupRow[0]);
  const analytical = (i: number): number | null =>
    rows0 === 0 || rollupRow === undefined ? null : Number(rollupRow[i + 1]);

  const rows: Array<[Quantity, number | null, number | null, string | null, boolean]> = [
    ["messages", analytical(0), op.messagesSent, "usage_periods", true],
    // `activeUsers` is null when the tenant has no period row at all, and 0 when it has one
    // with no users — the same distinction the rest of the report keeps.
    [
      "activeUsers",
      analytical(1),
      op.messagesSent === null ? null : op.activeUsers,
      "usage_active_users",
      true,
    ],
    ["connectionMinutes", analytical(2), op.connectionMinutes, "usage_periods", true],
    // NO OPERATIONAL SOURCE ANYWHERE, and that is a fact about the platform rather than about
    // this tenant. `usage_periods` carries messages and connection-minutes,
    // `usage_active_users` carries the third, and nothing carries a stored total.
    [
      "storedMessages",
      stored[0] === undefined || Number(stored[0][0]) === 0 ? null : Number(stored[0][1]),
      null,
      null,
      false,
    ],
  ];

  return rows.map(([quantity, a, o, source, hasSource]) => {
    const c: Comparison = { analytical: a, operational: o, hasOperationalSource: hasSource };
    return {
      environmentId,
      period,
      quantity,
      analytical: a,
      operational: o,
      operationalSource: source,
      differencePct: differencePct(c),
      verdict: verdictFor(c),
    };
  });
}

/** FR-ANL-06's *"raises an alert"*, as the only thing this platform can currently mean by it.
 *
 * THE LINE THAT DECIDES WHETHER THE ALERT FIRES LIVED IN A FILE NOTHING TESTS.
 * `scripts/reconcile-usage.mjs` closed with `process.exit(breached.length > 0 ? 1 : 0)` — one
 * expression, no test, and the whole of FR-008's observable behaviour. Moved here so a test can
 * ask it directly instead of a human reading output.
 *
 * `not-comparable` and `no-data` DO NOT RAISE. A quantity with no operational counterpart is a
 * gap in the platform and a tenant with nothing on either side is a tenant with nothing; a job
 * that exits 1 for either would exit 1 every day, and a check that always fires stops being
 * read. The gap is the chapter's subject and not this exit code's. */
export function exitCodeFor(rows: readonly ReconcileRow[]): 0 | 1 {
  return rows.some((r) => r.verdict === "breach") ? 1 : 0;
}
