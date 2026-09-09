/** The usage period an instant belongs to: the first day of its calendar month,
 * in UTC, as a plain `YYYY-MM-DD` string.
 *
 * ONE DEFINITION, IMPORTED BY EVERYTHING. The migration's default, the
 * repository's predicate and the relay's read all name this function rather than
 * repeating `date_trunc`, because a quota that disagrees with itself about which
 * month it is counts a tenant twice in one and not at all in the other.
 *
 * A STRING, NOT A `Date`. The column is a Postgres `date` — this project's first,
 * against 28 `timestamp` columns — and `period` is half the primary key of
 * `usage_periods` and a third of `usage_active_users`'s. Drizzle's `date` in its
 * default mode reads and writes `YYYY-MM-DD` strings, so a string here is the
 * value the key is actually built from; handing a `Date` around instead would put
 * a timezone-bearing object on both sides of a comparison that has no timezone,
 * and the failure would be a row that cannot be found rather than an error
 * (research R7a).
 *
 * UTC, and the tests say why. `date_trunc('month', now())` without a zone answers
 * September on a server running ahead of UTC on the last evening of August, and
 * the row lands in a period nobody reads. */
export function periodOf(at: Date): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/** The period AFTER this one — the month a refused tenant's sends resume in.
 *
 * ONE COPY, AND THERE WERE TWO. `quota.error.ts` and `quota-email.ts` each carried
 * this arithmetic: the same December wrap, the same four `??` fallbacks, differing
 * only in what they did with the answer — the error returns `2027-01-01` and the
 * email says `January 2027`. Two copies of a rule are two rules, and the rule here is
 * "which month does the refusal end in", which a customer reads on an invoice.
 *
 * The fallbacks live here now, once. They exist because `split("-").map(Number)` is
 * typed `(number | undefined)[]` and cannot be narrowed by the compiler, not because
 * a period can be malformed — every one comes from `periodOf` above or from a
 * Postgres `date` column. That makes them unreachable arms, and having them in one
 * file rather than two is the difference between one uncoverable branch pair and
 * three. */
export function nextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const nextMonth = m === 12 ? 1 : (m ?? 1) + 1;
  const nextYear = m === 12 ? (y ?? 0) + 1 : y;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}
