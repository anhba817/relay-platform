import { describe, expect, it } from "vitest";

import {
  assertEnvironmentId,
  driftFor,
  exitCodeFor,
  outstandingReservations,
  partitionByTenant,
  STORAGE_THRESHOLD,
  verdictFor,
  type StorageComparison,
  type StorageRow,
} from "./storage-reconcile";

// THE HALF THAT RUNS WITHOUT A STORE (chapter 4.16), beside `reconcile.test.ts`.
//
// The thresholds, the direction of a drift, the one-sided verdicts and the unattributable
// category are arithmetic. Arithmetic tested only through a live ClickHouse and a live
// MinIO is tested slowly and rarely, which is why `reconcile.ts` was split this way and
// why this file exists at all.
const ENV = "11111111-1111-1111-1111-111111111111";
const cmp = (over: Partial<StorageComparison> = {}): StorageComparison => ({
  environmentId: ENV,
  metered: 1_000_000,
  inStore: 1_000_000,
  reserved: 0,
  ...over,
});

describe("what the two sides say about each other", () => {
  it("agrees when they match and nothing is outstanding", () => {
    expect(verdictFor(cmp())).toBe("agree");
  });

  it("calls a gap explained by reservations what it is, not agreement", () => {
    // THE LANE MADE THIS VERDICT NECESSARY. 6,580 of its 8,662 charged objects are slots
    // taken and never uploaded to, carrying 4,436 MB against a store holding 30.7 MB.
    // "agree" over that gap would be true and unbelievable; "meter-high" would be wrong.
    expect(verdictFor(cmp({ metered: 5_000_000, inStore: 1_000_000, reserved: 4_000_000 })))
      .toBe("reservations-only");
  });

  it("reports the direction when the gap is not explained", () => {
    expect(verdictFor(cmp({ metered: 2_000_000, inStore: 1_000_000 }))).toBe("meter-high");
    expect(verdictFor(cmp({ metered: 1_000_000, inStore: 2_000_000 }))).toBe("meter-low");
  });

  it("keeps a store holding more than the meter knows about as its own answer", () => {
    // `meter-low` is always wrong and `meter-high` is sometimes reservations. Collapsing
    // the two into "differs" would hide the only one that cannot be explained away.
    expect(verdictFor(cmp({ metered: 0, inStore: 500_000, reserved: 9_000_000 })))
      .toBe("meter-low");
  });

  it("distinguishes one-sided from absent, which 4.7 found was the whole answer", () => {
    expect(verdictFor(cmp({ metered: null, inStore: null }))).toBe("no-data");
    expect(verdictFor(cmp({ metered: null }))).toBe("not-comparable");
    expect(verdictFor(cmp({ inStore: null }))).toBe("not-comparable");
  });

  it("sits on the bound rather than beside it", () => {
    // The boundary cases are ON the threshold, which is how you know the comparison is
    // `<=` and not `<`. 4.7 changed one operator and exactly one test moved.
    const onTheBound = cmp({ metered: 1_000_000, inStore: 1_000_000 - 10_000 });
    expect(Math.abs(driftFor(onTheBound)!)).toBeCloseTo(STORAGE_THRESHOLD, 10);
    expect(verdictFor(onTheBound)).toBe("agree");
    expect(verdictFor(cmp({ metered: 1_000_000, inStore: 1_000_000 - 10_001 })))
      .toBe("meter-high");
  });

  it("answers null for a drift it cannot compute", () => {
    expect(driftFor(cmp({ inStore: null }))).toBeNull();
  });
});

describe("attributing the inventory", () => {
  it("splits keys by their environment prefix", () => {
    const { byTenant } = partitionByTenant([
      { key: `${ENV}/a`, bytes: 10 },
      { key: `${ENV}/b`, bytes: 5 },
      { key: "22222222-2222-2222-2222-222222222222/c", bytes: 7 },
    ]);
    expect(byTenant.get(ENV)).toBe(15);
    expect(byTenant.size).toBe(2);
  });

  it("reports keys belonging to no tenant rather than skipping them", () => {
    // Four such prefixes exist on the lane — probes and test debris — and NONE is on the
    // listing's first page, which is how a one-page measurement concluded there were
    // none at all. Skipping them means a bucket full of debris reports clean.
    const { byTenant, unattributable } = partitionByTenant([
      { key: `${ENV}/a`, bytes: 10 },
      { key: "thumbnail-itest/x", bytes: 900 },
      { key: "probe/y", bytes: 100 },
    ]);
    expect(byTenant.size).toBe(1);
    expect(unattributable).toEqual({ keys: 2, bytes: 1_000 });
  });
});

describe("which reservations are still outstanding", () => {
  const OTHER = "22222222-2222-2222-2222-222222222222";
  const pending = [
    { environmentId: ENV, objectKey: `${ENV}/uploaded`, declaredBytes: 400 },
    { environmentId: ENV, objectKey: `${ENV}/never-came`, declaredBytes: 1_000 },
    { environmentId: OTHER, objectKey: `${OTHER}/never-came`, declaredBytes: 70 },
  ];

  it("does not count a pending object the store already holds", () => {
    // **A PENDING ROW IS NOT AUTOMATICALLY AN OUTSTANDING RESERVATION**, and the lane is
    // what said so: 267 of its 6,580 pending rows name a key the bucket holds, 6,533,174
    // declared bytes — 21% of everything in it. 4.13's sweep is why that is ordinary; an
    // object is uploaded and stays `pending` until the sweep HEADs it. Counting those as
    // outstanding subtracts them twice and invents a `meter-low`.
    const out = outstandingReservations(pending, new Set([`${ENV}/uploaded`]));
    expect(out.get(ENV)).toBe(1_000);
    expect(out.get(OTHER)).toBe(70);
  });

  it("names no tenant whose every reservation has landed", () => {
    // Absent, not zero: the caller defaults it, and a tenant with nothing outstanding
    // must not be dragged into the comparison by this read alone.
    const out = outstandingReservations(pending, new Set(pending.map((p) => p.objectKey)));
    expect(out.size).toBe(0);
  });

  it("is the term that turns a raw gap into a verdict", () => {
    // The two halves in one assertion: the same tenant reads `meter-high` without the
    // term and `reservations-only` with it.
    const bare: StorageComparison = { environmentId: ENV, metered: 1_400, inStore: 400, reserved: 0 };
    expect(verdictFor(bare)).toBe("meter-high");
    const out = outstandingReservations(pending, new Set([`${ENV}/uploaded`]));
    expect(verdictFor({ ...bare, reserved: out.get(ENV) ?? 0 })).toBe("reservations-only");
  });
});

describe("what the job reports to whatever runs it", () => {
  const row = (verdict: StorageRow["verdict"]): StorageRow => ({
    ...cmp(),
    verdict,
    drift: 0,
  });

  it("exits non-zero only for an unexplained drift", () => {
    // ADR-28: an exit code is what the clause can currently mean, because this platform
    // has no alerting integration and no runner for a recurring job.
    expect(exitCodeFor([row("agree"), row("reservations-only")])).toBe(0);
    expect(exitCodeFor([row("no-data"), row("not-comparable")])).toBe(0);
    expect(exitCodeFor([row("agree"), row("meter-high")])).toBe(1);
    expect(exitCodeFor([row("meter-low")])).toBe(1);
  });

  it("exits zero over nothing, because an empty run is not a breach", () => {
    expect(exitCodeFor([])).toBe(0);
  });
});

describe("refusing its own arguments", () => {
  it("takes a uuid and nothing else", () => {
    expect(assertEnvironmentId(ENV)).toBe(ENV);
    expect(() => assertEnvironmentId("relay")).toThrow("not an environment id");
    expect(() => assertEnvironmentId("")).toThrow();
  });
});
