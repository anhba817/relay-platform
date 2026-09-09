/** The percentages an organisation is emailed at (FR-RTL-07). */
export const THRESHOLDS = [50, 80, 100] as const;

/** Which thresholds a usage increase crossed, ascending.
 *
 * Called inside the send transaction, between the increment and the cap check,
 * so it takes the two numbers the transaction already holds and asks nothing
 * else. No database, no clock, no rounding policy hidden in a helper.
 *
 * `quota` is null for an environment with no cap configured, and null crosses
 * nothing at any usage — the absent state stays absent rather than becoming
 * `Infinity` or `-1` somewhere up the call stack.
 *
 * A quota of ZERO is a different thing from an absent one: it means refuse
 * everything, and every threshold is already met. Guarded before the division
 * rather than after it. */
export function thresholdsCrossed(
  before: number,
  after: number,
  quota: number | null,
): number[] {
  if (quota === null) return [];
  if (after <= before) return [];
  if (quota === 0) return [...THRESHOLDS];

  const pct = (n: number) => (n / quota) * 100;
  const from = pct(before);
  const to = pct(after);
  // `>` on the left and `>=` on the right: FR-RTL-07 says "reaches", so landing
  // exactly on 50% crosses it, and starting exactly on 50% does not cross it
  // again.
  return THRESHOLDS.filter((t) => from < t && to >= t);
}
