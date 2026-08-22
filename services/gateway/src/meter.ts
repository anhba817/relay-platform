// Connection-minutes, from the service that cannot write them (chapter 3.11).
//
// The api can count messages and distinct users because both are already rows.
// It cannot count a connection: nothing records one, and the only process that
// can see one is this one — which owns no tables (ADR-05, and `registry.ts`
// states the property: "no pg, no drizzle-orm, no repository import"). So the
// gateway observes and the api records, and everything interesting lives in the
// protocol between them.
//
// This file has two halves and they are separated on purpose. Below is the pure
// one — arithmetic over instants, no timer, no transport, no api client — which
// is the half every timing assertion in this chapter drives on a clock it
// supplies. The timer and the report live under it.

/** The usage period an instant belongs to. DUPLICATED FROM THE API, deliberately.
 *
 * `limits.ts` next door already duplicates the api's window arithmetic and says
 * why: "a package for two small functions would be an abstraction constitution
 * VII asks to be justified, and this one could not be." The same argument holds
 * here and the stakes are higher — a rate-limit window that disagrees between two
 * services costs one window of over-service, while a PERIOD that disagrees puts a
 * tenant's minutes in a month nobody reads. So the copy is pinned by a drift test
 * in both packages rather than by good intentions (research R18). */
export function periodOf(at: Date): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/** The minute an instant belongs to — the unit itself, floored, in UTC. */
export function minuteOf(at: Date): string {
  const y = at.getUTCFullYear();
  const mo = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  const h = String(at.getUTCHours()).padStart(2, "0");
  const mi = String(at.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

const MINUTE_MS = 60_000;

/** Floor an instant to the start of its minute. The bucket a connection is
 * charged for is a span of wall clock, not an offset from when it opened. */
function floorToMinute(at: Date): number {
  return Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
}

/** How many minute buckets a connection has occupied, per period.
 *
 * A CONNECTION IS CHARGED FOR EVERY CALENDAR MINUTE IT WAS OPEN FOR ANY PART OF.
 * Open at 00:00:59 and closed at 00:01:01 is two seconds of wall clock and TWO
 * connection-minutes, because it was present in both minutes. A five-second
 * socket costs one. That charges reconnect churn, which summing seconds does
 * not, and it is the answer this chapter gives to the open question in
 * `docs/04-srs.md` about per-second precision.
 *
 * SPLIT BY PERIOD, because a socket open across midnight on the first owes
 * minutes to two months and each is credited independently (FR-009). The api is
 * never asked to do this arithmetic on the gateway's behalf: the wire carries one
 * entry per period, already decided.
 *
 * Counts from `openedAt`'s bucket through `at`'s INCLUSIVE, so a connection that
 * has just opened already owes its first minute. Returning zero for a fresh
 * socket would make a report for it indistinguishable from no report at all. */
export function bucketsFor(openedAt: Date, at: Date): Record<string, number> {
  const first = floorToMinute(openedAt);
  const last = floorToMinute(at);
  const totals: Record<string, number> = {};
  if (last < first) return totals;
  for (let ms = first; ms <= last; ms += MINUTE_MS) {
    const period = periodOf(new Date(ms));
    totals[period] = (totals[period] ?? 0) + 1;
  }
  return totals;
}
