/** DR-17's comparison, as arithmetic over two numbers (chapter 4.16).
 *
 * *"Stored-bytes-per-tenant shall be maintained as a daily rollup summing `media_events`
 * deltas, **reconciled weekly against an object-storage inventory listing** — the media
 * analogue of FR-ANL-06."*
 *
 * **THIS FILE IS THE HALF THAT RUNS WITHOUT A STORE**, which is `reconcile.ts`'s shape
 * and its header's own words. The verdicts, the thresholds and the exit code are pure
 * functions a unit test drives in milliseconds; `reconcileStorage` is the thin composed
 * one that reads the rollup and the inventory and hands both to them.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 * **AND THE TWO SIDES MEASURE DIFFERENT THINGS, WHICH MEASUREMENT FOUND AND NO READING
 * OF THE CLAUSE WOULD HAVE.** On the development lane:
 *
 *     the meter charges (state <> 'rejected')     8,662 rows      ~4,440 MB
 *       of which PENDING                          6,580 rows       4,436 MB
 *     the store actually holds                    1,775 objects     30.7 MB
 *
 * **99.9% of what the quota charges is slots that were taken and never uploaded to.**
 * That is FR-MED-01 and 4.10's design working — a slot reserves against the quota the
 * moment it is issued, because the alternative is a tenant reserving without limit — and
 * it means *"does the meter match the store"* compares a reservation against a delivery.
 *
 * So the comparison has THREE outcomes and not two. A tenant whose meter exceeds its
 * store by exactly its outstanding reservations is **not** drifting; it has unused slots.
 * Only the part that cannot be explained by reservations is a drift, and a store holding
 * MORE than the meter knows about is the other direction and always wrong.
 * ──────────────────────────────────────────────────────────────────────────────────── */

export interface StorageComparison {
  environmentId: string;
  /** Accumulated from `stored_bytes_delta`, bounded by the rollup's 25-month TTL. */
  metered: number | null;
  /** Summed from the inventory listing, for keys prefixed by this environment. */
  inStore: number | null;
  /** Declared bytes on objects the store has no reason to hold yet — slots reserved and
   * not uploaded to. The quota charges them; the store cannot show them. */
  reserved: number;
}

export type StorageVerdict =
  | "agree"
  | "meter-high"
  | "meter-low"
  | "reservations-only"
  | "not-comparable"
  | "no-data";

/** 1%: looser than FR-ANL-06's 0.1%, and the reason is in the numerator. That clause
 * compares two counts of the same events; this compares a delta-summed level against a
 * listing taken at a different instant, with uploads landing in between. A tighter bound
 * would report the clock rather than the platform. */
export const STORAGE_THRESHOLD = 0.01;

/** The verdict, and `reservations-only` is the one the lane made necessary.
 *
 * ORDER MATTERS. `no-data` before `not-comparable` before the arithmetic, because a
 * tenant with nothing on either side is not a tenant whose sides disagree — 4.7 found
 * that collapsing those two let the platform's largest defect read as an absence of
 * evidence, and 1,317 of its 1,385 tenants were in one of them. */
export function verdictFor(
  c: StorageComparison,
  threshold = STORAGE_THRESHOLD,
): StorageVerdict {
  if (c.metered === null && c.inStore === null) return "no-data";
  if (c.metered === null || c.inStore === null) return "not-comparable";

  const unexplained = c.metered - c.inStore - c.reserved;
  const denominator = Math.max(c.metered, c.inStore, 1);
  const drift = Math.abs(unexplained) / denominator;
  if (drift <= threshold) {
    // Inside the bound either way. `reservations-only` says the two sides differ and the
    // difference is entirely accounted for — a verdict a reader needs, because "agree"
    // over a 4.4 GB gap would be true and unbelievable.
    return c.reserved > 0 && c.metered !== c.inStore ? "reservations-only" : "agree";
  }
  return unexplained > 0 ? "meter-high" : "meter-low";
}

/** How far apart, as a fraction, once reservations are accounted for. `null` when the two
 * sides cannot be compared at all. */
export function driftFor(c: StorageComparison): number | null {
  if (c.metered === null || c.inStore === null) return null;
  const denominator = Math.max(c.metered, c.inStore, 1);
  return (c.metered - c.inStore - c.reserved) / denominator;
}

/** An environment id, or a refusal. `reconcile.ts` validates its inputs and this follows,
 * because both take one from a command line. */
export function assertEnvironmentId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`not an environment id: ${value}`);
  }
  return value;
}

export interface StorageRow extends StorageComparison {
  verdict: StorageVerdict;
  drift: number | null;
}

/** Non-zero when any tenant is outside the bound.
 *
 * **AN EXIT CODE IS WHAT THE CLAUSE CAN CURRENTLY MEAN** (ADR-28). This platform has no
 * alerting integration and no runner for a recurring job, so DR-17's *"weekly"* is unmet
 * by decision and this is the whole of what a future scheduler would read. */
export function exitCodeFor(rows: readonly StorageRow[]): 0 | 1 {
  return rows.some((r) => r.verdict === "meter-high" || r.verdict === "meter-low") ? 1 : 0;
}

/** Keys the inventory holds that belong to no tenant — test debris, probes, anything
 * written outside the platform's `${environment_id}/${id}` layout.
 *
 * **REPORTED, NOT SKIPPED.** Four such prefixes exist on this lane today
 * (`analyze-probe`, `probe`, `r9-measure`, `thumbnail-itest`) carrying 83 objects, and
 * **none of them is on the listing's first page** — which is how an earlier draft of this
 * chapter's research concluded every key was tenant-prefixed. Skipping them silently
 * means a bucket full of debris reports clean. */
export function partitionByTenant(objects: readonly { key: string; bytes: number }[]): {
  byTenant: Map<string, number>;
  unattributable: { keys: number; bytes: number };
} {
  const byTenant = new Map<string, number>();
  let keys = 0;
  let bytes = 0;
  for (const o of objects) {
    const prefix = o.key.split("/")[0] ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prefix)) {
      keys += 1;
      bytes += o.bytes;
      continue;
    }
    byTenant.set(prefix, (byTenant.get(prefix) ?? 0) + o.bytes);
  }
  return { byTenant, unattributable: { keys, bytes } };
}
