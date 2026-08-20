import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BATCH_SOURCES, MAX_PRODUCT_BATCH } from "./sentinel.js";

// The bound in `sentinel.ts` is a literal, and this is what stops it being a
// silent one (research R7).
//
// The product's three `BATCH_SIZE` constants are not exported, and importing
// `outbox/relay.ts` into a setup file would drag drizzle, pg and the repository
// along with it. So the bound is declared locally and checked here by reading the
// files — the same shape chapter 3.8 used to prove close code 4008 is emitted by
// nothing, and for the same reason: the claim is about source, so the check reads
// source.

const PLATFORM = join(import.meta.dirname, "..", "..", "..");

function defaultsIn(file: string): number[] {
  const text = readFileSync(join(PLATFORM, file), "utf8");
  return [
    ...text.matchAll(/BATCH_SIZE\s*=\s*(\d[\d_]*)/g),
    ...text.matchAll(/\blimit\s*=\s*(\d[\d_]*)/g),
  ].map((m) => Number(m[1]!.replace(/_/g, "")));
}

/** `repository.ts` used to declare `limit = 100` and no longer declares anything:
 * T022 removed the last default, which is the point of T022. So it is watched for
 * the opposite property — that no default has come back — while the three relays
 * are watched for having one. The file stayed on the list because a default
 * reintroduced there is exactly the regression worth catching. */
const NO_DEFAULT_EXPECTED = "services/api/src/db/repository.ts";

describe("the bait bound still dominates every product default", () => {
  it("finds a default in each file it claims to watch", () => {
    // A grep that matches nothing passes vacuously. If a file stops declaring a
    // default — or is renamed — this test must fail rather than fall silent.
    for (const file of BATCH_SOURCES) {
      if (file === NO_DEFAULT_EXPECTED) continue;
      expect(defaultsIn(file).length, `no batch default found in ${file}`)
        .toBeGreaterThan(0);
    }
  });

  it("still finds no batch default in the file feature 030 emptied", () => {
    expect(defaultsIn(NO_DEFAULT_EXPECTED)).toEqual([]);
  });

  it("is at least as large as the largest of them", () => {
    const all = BATCH_SOURCES.flatMap(defaultsIn);
    const largest = Math.max(...all);
    // THE POINT: raise a product default past this and the bait quietly stops
    // being bait, because a caller who omits a bound would reach its own rows
    // before reaching the plant. This fails instead.
    expect(MAX_PRODUCT_BATCH, `largest product default is ${largest}`)
      .toBeGreaterThanOrEqual(largest);
  });
});
