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
    return c.reserved > 0 && c.metered !== c.inStore
      ? "reservations-only"
      : "agree";
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
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
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
  return rows.some(
    (r) => r.verdict === "meter-high" || r.verdict === "meter-low",
  )
    ? 1
    : 0;
}

/** Keys the inventory holds that belong to no tenant — test debris, probes, anything
 * written outside the platform's `${environment_id}/${id}` layout.
 *
 * **REPORTED, NOT SKIPPED.** Four such prefixes exist on this lane today
 * (`analyze-probe`, `probe`, `r9-measure`, `thumbnail-itest`) carrying 83 objects, and
 * **none of them is on the listing's first page** — which is how an earlier draft of this
 * chapter's research concluded every key was tenant-prefixed. Skipping them silently
 * means a bucket full of debris reports clean. */
export function partitionByTenant(
  objects: readonly { key: string; bytes: number }[],
): {
  byTenant: Map<string, number>;
  unattributable: { keys: number; bytes: number };
} {
  const byTenant = new Map<string, number>();
  let keys = 0;
  let bytes = 0;
  for (const o of objects) {
    const prefix = o.key.split("/")[0] ?? "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        prefix,
      )
    ) {
      keys += 1;
      bytes += o.bytes;
      continue;
    }
    byTenant.set(prefix, (byTenant.get(prefix) ?? 0) + o.bytes);
  }
  return { byTenant, unattributable: { keys, bytes } };
}

// ---------------------------------------------------------------------------
// THE GATHERING.
//
// Everything above is arithmetic and runs with no store. Everything below reads THREE of
// them — the rollup, the bucket and Postgres — which is one more than `reconcile.ts`
// needs and is not a convenience. The analytical side records a `reserved` event and no
// "uploaded" event, so **nothing in the analytical store can tell an outstanding slot
// from a delivered object**; the term that explains the gap has to come from the
// operational side, and which of those slots are still outstanding can only be answered
// by the inventory. Three sides, because the question has three.
//
// It also deepens the constitution III question chapter 4.7 asked and did not settle:
// the service that IS the operational path now reads the analytical store, the object
// store and its own database in one function. `gaps.md` carries it.
// ---------------------------------------------------------------------------

import type { Db } from "../db/client";
import {
  environmentsWithMedia,
  pendingMediaObjects,
  type PendingObject,
} from "../db/storage-reads";
import {
  listObjects,
  type StoreConfig,
  type StoredObject,
} from "../media/store";
import type { AnalyticalStore } from "./clickhouse";

const DB_ANALYTICS = "relay_analytics";

/** Reservations the store has no key for, per tenant — the explanatory term.
 *
 * **A PENDING ROW IS NOT AUTOMATICALLY AN OUTSTANDING RESERVATION**, and the lane says so
 * in one number: 267 of its 6,580 pending rows name a key the bucket holds. 4.13's sweep
 * is what makes that ordinary — an object is uploaded and stays `pending` until the sweep
 * HEADs it — so at any instant some charged-but-unverified objects are in both totals.
 * Counting them as outstanding subtracts them twice and invents a `meter-low`.
 *
 * Called by `reconcileStorage`. */
export function outstandingReservations(
  pending: readonly PendingObject[],
  storeKeys: ReadonlySet<string>,
): Map<string, number> {
  const byTenant = new Map<string, number>();
  for (const p of pending) {
    if (storeKeys.has(p.objectKey)) continue;
    byTenant.set(
      p.environmentId,
      (byTenant.get(p.environmentId) ?? 0) + p.declaredBytes,
    );
  }
  return byTenant;
}

export interface StorageReport {
  rows: StorageRow[];
  /** FR-007. **The union of the three sides**, not the count of rows that disagreed — an
   *  instrument that reports how many problems it found has said nothing about how much it
   *  looked at. */
  tenantsExamined: number;
  /** Where the population came from, side by side, because the union alone cannot say
   *  which side is carrying it. Measured on this lane: the rollup knows 84 tenants and
   *  Postgres 1,678, so the comparison is about the operational side's population with a
   *  handful of analytical and bucket-only strays on top. */
  sides: {
    rollup: number;
    bucket: number;
    reservations: number;
    withMedia: number;
  };
  unattributable: { keys: number; bytes: number };
  inventory: {
    objects: number;
    bytes: number;
    pages: number;
    truncated: boolean;
  };
}

/** DR-17's weekly comparison, for every tenant at once.
 *
 * **EVERY TENANT, WHERE `reconcile.ts` TAKES ONE**, and the instrument decides that rather
 * than taste. FR-ANL-06's operational side is a row per tenant-period and can be asked for
 * one; DR-17's is a listing of a bucket, which arrives whole. Nine requests give every
 * tenant's contents, so a per-tenant entry point would re-list the bucket per tenant or
 * hold the same listing behind a narrower signature.
 *
 * **AN ABSENT TENANT HOLDS ZERO, NOT AN UNKNOWN — WHEN THE LISTING FINISHED.** A complete
 * listing is evidence about every key in the bucket, including the ones that are not there,
 * so a tenant with no keys has `inStore = 0` and can agree with a meter that says zero.
 * The moment the listing is truncated that stops being true and every tenant's `inStore`
 * becomes `null`: a partial listing cannot distinguish "no keys" from "not reached", and
 * **a reconciliation that reports agreement about a bucket it did not finish reading is
 * the 4.13 defect in the instrument built to catch it.**
 *
 * IT WRITES NOTHING. Two invocations return the same report. */
export async function reconcileStorage(
  db: Db,
  store: AnalyticalStore,
  config: StoreConfig,
  opts: { maxPages?: number } = {},
): Promise<StorageReport> {
  // THE INVENTORY FIRST, because the other two are interpreted against it: the
  // reservations need its keys, and the rollup's absent tenants only mean zero if it
  // finished.
  const inventory = await listObjects(config, opts);
  const keys = new Set(inventory.objects.map((o: StoredObject) => o.key));
  const { byTenant, unattributable } = partitionByTenant(inventory.objects);

  // THE LEVEL IS A BALANCE, SO IT SUMS EVERY DAY THE ROLLUP STILL HOLDS. No window: a
  // month's `stored_bytes_delta` is that month's CHANGE, which is a different question
  // that reads as a plausible wrong answer — `reconcile.ts` records the same trap one
  // column over. **The 25-month TTL is therefore the horizon of the whole comparison**
  // (`0014`, correcting `0010`'s "No TTL"), and a tenant whose first upload is older
  // than that has a level short by everything that expired.
  //
  // `GROUP BY` RATHER THAN A BARE AGGREGATE, WHICH IS WHY THERE IS NO `count()` HERE.
  // 4.6 established that a bare aggregate with no GROUP BY always returns exactly one
  // row, and 4.7 paid for it: every empty tenant reported `0` and every `no-data` verdict
  // came back as a breach. Under a GROUP BY the opposite holds — a group that matched
  // nothing produces no row — so absence is representable and needs no second column to
  // carry it.
  const rollup = await store.query(
    `SELECT environment_id, sum(stored_bytes_delta)
       FROM ${DB_ANALYTICS}.daily_usage_billing
      GROUP BY environment_id
      FORMAT TSV`,
  );
  const metered = new Map<string, number>();
  for (const [id, sum] of rollup) {
    if (id !== undefined && sum !== undefined) metered.set(id, Number(sum));
  }

  const reserved = outstandingReservations(await pendingMediaObjects(db), keys);
  const withMedia = await environmentsWithMedia(db);

  // THE UNION OF FOUR SIDES, AND EACH ONE CONTRIBUTES A TENANT THE OTHERS DO NOT.
  // Measured on this lane: the rollup holds 84 environments, Postgres holds 1,678 with
  // media rows, and the bucket holds keys under prefixes belonging to neither. Taking
  // any one side's list as the population is how a comparison reports on the tenants it
  // already agrees with.
  //
  // **`withMedia` IS THE FOURTH AND IT WAS NOT IN THE FIRST DESIGN.** Without it the
  // population is the union of the rollup, the bucket and the outstanding reservations —
  // and a tenant whose objects are all `ready`, whose keys the bucket does not hold and
  // which the rollup has never heard of appears on none of those three. **That is the
  // drift this comparison exists to find**, and it would have been the one tenant nobody
  // looked at. The lane holds 1,074 ready rows naming a key the bucket does not have.
  const tenants = [
    ...new Set([
      ...metered.keys(),
      ...byTenant.keys(),
      ...reserved.keys(),
      ...withMedia,
    ]),
  ];
  tenants.sort();

  const rows = tenants.map((environmentId) => {
    const c: StorageComparison = {
      environmentId,
      metered: metered.get(environmentId) ?? null,
      inStore: inventory.truncated
        ? (byTenant.get(environmentId) ?? null)
        : (byTenant.get(environmentId) ?? 0),
      reserved: reserved.get(environmentId) ?? 0,
    };
    return { ...c, verdict: verdictFor(c), drift: driftFor(c) };
  });

  return {
    rows,
    tenantsExamined: tenants.length,
    sides: {
      rollup: metered.size,
      bucket: byTenant.size,
      reservations: reserved.size,
      withMedia: withMedia.length,
    },
    unattributable,
    inventory: {
      objects: inventory.objects.length,
      bytes: inventory.objects.reduce(
        (a: number, o: StoredObject) => a + o.bytes,
        0,
      ),
      pages: inventory.pages,
      truncated: inventory.truncated,
    },
  };
}

// ---------------------------------------------------------------------------
// WHAT THIS COMPARISON CANNOT CATCH, AND WHEN IT DOES NOT RUN.
//
// **THE METERED LEVEL NEVER FALLS FOR A DELETION, BECAUSE NOTHING DELETES.** `deleted` is
// one of four causes in `StorageCause` and its producer is nothing: chapter 4.15 established
// that no code path removes a `media_objects` row — the rejection path subtracts the bytes
// and keeps the row on purpose — and the reaper that will is `docs/12` row 22's, the erasure
// chapter. So the failure a delta-summed level is most exposed to, a LOST `deleted` record
// leaving the meter permanently over, **cannot arise here, because no such record is ever
// sent.** A run of green verdicts is evidence about the three causes that do exist and about
// nothing else, and the day the reaper ships it is evidence about a fourth it has never seen.
//
// **AND 95.5% OF TENANTS PRODUCE NO VERDICT AT ALL.** Measured on this lane at phase 4:
// 1,784 of 1,868 examined tenants are `not-comparable`, because the rollup holds 84
// environments and Postgres holds 1,678 with media rows. 4.6's *"a rollup created late is
// permanently short"* is the reason and this is its widest instance — the producer ships in
// this chapter, so the meter's history begins here while the bucket's does not. Collapsing
// that into "missing data" is what 4.7 refused, and it is refused again: `not-comparable` is
// a verdict, it is counted, and it is by far the commonest answer this job gives today.
//
// **THE WEEKLY CADENCE HAS NO RUNNER** (ADR-28). DR-17 says *"reconciled weekly"* and there
// is no `schedule:` trigger in `ci.yml`, no cron, and no job runner of any kind in this
// repository — the same absence 4.9 recorded for FR-ANL-06's *"daily"*, with the same
// evidence and the same conclusion. `scripts/reconcile-storage.mjs` is invokable and nothing
// invokes it. The clause is recorded unmet in the SRS rather than left to look built, which
// is FR-011 and is the only thing a chapter can do about an absence it is not the place to
// fix. **An exit code is what "raises an alert" can currently mean**, and `exitCodeFor` is
// where that is decided so a test can reach it.
// ---------------------------------------------------------------------------
