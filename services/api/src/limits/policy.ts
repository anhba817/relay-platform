// The limit policy: what each environment is allowed, and what each number rests
// on (chapter 3.8, research R26).
//
// R4 chose all four of these by judgement and checked none of them against a
// document stating this platform's scale. The fourteenth analysis pass read the
// SRS's NFR tables and found that one of them made a P1 requirement unreachable,
// so all four were re-derived rather than the broken one patched.
//
// WHAT WENT WRONG IS WORTH KEEPING. The connect limit was 60/min, on the
// reasoning that "sixty establishments a minute per environment is a client
// reconnecting hard, not a client working". True of a client. The limit is per
// ENVIRONMENT, and an environment is a tenant — NFR-SCL-01 puts ten thousand
// concurrent connections on one gateway instance and FR-RTM-09 allows five per
// user, so filling one instance from cold would have taken 167 minutes.
//
// Each number below names what it rests on, including the one that rests on
// nothing. That is the actual fix; the new value is a consequence of it.

/** Per environment, per minute. Overridable per environment (FR-RTL-04, FR-RTL-04);
 * these apply when a column is null, which means "no override" and never zero —
 * refuse-everything has to stay expressible. */
export const DEFAULT_LIMITS = {
  /** NO ANCHOR, and recorded as such. No SRS requirement caps a tenant's request
   * rate; NFR-PRF-02's p95 under 150 ms is a latency target, not a throughput
   * bound. Matched to the send limit because a REST send consumes both budgets
   * (FR-RTL-01), and two different ceilings on one operation would mean a client
   * hitting one while the other says it has room. */
  rest: 600,

  /** 1% of NFR-SCL-03's stated 1,000 messages per second aggregate — 60,000 a
   * minute across the platform. So a hundred environments at their ceiling
   * saturate it, and the hundred-and-first is what this protects. */
  send: 600,

  /** NFR-SCL-01's ten thousand connections per gateway instance, divided by
   * FR-RTM-09's five per user, re-established inside one window so a deploy stays
   * one reconnection cycle (NFR-REL-03).
   *
   * IT IS STILL A LIMIT. Its job is to stop a client reconnecting in a tight
   * loop, which does thousands a minute and is refused well before a legitimate
   * fleet is. It is not there to shape a tenant's capacity, and the old number
   * had those two jobs confused. */
  connect: 3_000,
} as const;

export type LimitedOperation = keyof typeof DEFAULT_LIMITS;

/** Failed authentications per source address per minute.
 *
 * NOT a per-environment column: the caller has not proved which environment they
 * are, which is the point of the limiter. Configuration, and configuration the
 * lane has to be able to raise — the api's own integration suites assert `401`
 * twenty-six times from one loopback address inside about 110 seconds, so a
 * threshold nothing could lift would refuse this project's own tests
 * (research R15).
 *
 * THE DEFAULT ENFORCES. Chapter 3.6's `RELAY_DISABLE_SWEEP` states the rule: a
 * flag whose default disabled a requirement would be a requirement nobody had
 * built.
 *
 * THE COST IT CARRIES, which R4 did not name: shared egress. An office behind one
 * NAT is one source address, so ten failed logins a minute is a whole building's
 * budget — and the refusal is deliberately indistinguishable from a wrong
 * credential (EIR-API-04), so they will experience it as a broken login. Kept anyway;
 * the alternative is a threshold high enough to be worthless against the attack
 * it exists for. */
export const DEFAULT_AUTH_FAILURES_PER_MINUTE = 10;

export function authFailureThreshold(): number {
  const raw = process.env["RELAY_AUTH_FAILURES_PER_MINUTE"];
  if (raw === undefined) return DEFAULT_AUTH_FAILURES_PER_MINUTE;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_AUTH_FAILURES_PER_MINUTE;
}

/** The window every counter uses. One minute, because every limit above is
 * expressed per minute and a second unit would be a second thing to reason
 * about. */
export const WINDOW_MS = 60_000;
