import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import {
  CANARY_TARGET,
  CLASSIFICATIONS,
  deriveTargets,
  shapeCounts,
  targetKey,
  type DerivedTarget,
} from "./targets";

// THE DERIVATION'S OWN TESTS, and they matter more than they look.
//
// The gauntlet attacks a list it derives from the running application rather than
// one somebody typed, because the fault NFR-SEC-09 exists to prevent is a route
// that exists and is unattacked. But a derivation has a failure mode a typed list
// does not: it can return NOTHING and pass. Express 5 renamed `_router` to
// `router`; an upgrade that renamed it again would leave this suite green while it
// attacked zero endpoints, which is worse than the hand-written list it replaces.
//
// So the derivation is checked before it is used: it found something, it found the
// route we know is there, and every target it found is classified exactly once.

describe("the gauntlet's target list derives from the running application", () => {
  let app: INestApplication;
  let derived: DerivedTarget[];
  let middlewareLayers: number;
  let property: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const result = deriveTargets(app.getHttpAdapter().getInstance());
    derived = result.targets;
    middlewareLayers = result.middlewareLayers;
    property = result.property;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── T016: the three that keep the derivation honest ────────────────────────
  it("found a router at all, and says which property answered", () => {
    expect(property).not.toBe("none");
    expect(["router", "_router"]).toContain(property);
  });

  it("found routes — an empty list is a broken derivation, not a clean surface", () => {
    expect(derived.length).toBeGreaterThan(0);
    // Middleware layers exist in any mounted express app. Zero of them alongside
    // zero routes is the signature of reading the wrong object.
    expect(middlewareLayers).toBeGreaterThan(0);
  });

  it("found the route that has existed since chapter 2.2", () => {
    expect(derived.map(targetKey)).toContain(CANARY_TARGET);
  });

  // ── T017: every target is classified ──────────────────────────────────────
  it("classifies every derived target exactly once", () => {
    const entries = new Map<string, number>();
    for (const c of CLASSIFICATIONS) entries.set(targetKey(c), (entries.get(targetKey(c)) ?? 0) + 1);
    const unclassified = derived.map(targetKey).filter((k) => !entries.has(k));
    const duplicated = [...entries].filter(([, n]) => n > 1).map(([k]) => k);
    // Named in the failure, because "22 !== 23" sends a reader to count rows.
    expect({ unclassified, duplicated }).toEqual({ unclassified: [], duplicated: [] });
  });

  // ── T018: and no classification outlives its route ────────────────────────
  it("has no classification entry that matches no derived target", () => {
    const found = new Set(derived.map(targetKey));
    const stale = CLASSIFICATIONS.map(targetKey).filter((k) => !found.has(k));
    // This is the direction that catches a rename. A route renamed with its
    // exemption left behind is a route nobody attacks and nobody misses.
    expect(stale).toEqual([]);
  });

  // ── T019 ──────────────────────────────────────────────────────────────────
  it("gives every exempt entry a reason", () => {
    const reasonless = CLASSIFICATIONS.filter(
      (c) => c.shape === "exempt" && (!c.because || c.because.trim() === ""),
    ).map(targetKey);
    expect(reasonless).toEqual([]);
  });

  // ── T020: the number SC-001 reports comes off a run ───────────────────────
  it("accounts for every derived target as attacked or exempt", () => {
    const counts = shapeCounts();
    const attacked = counts.read + counts.list + counts.write + counts.credential;
    const exempt = counts.exempt;
    // SC-001 asks for this number to be reported, and a number nobody can see is a
    // number nobody checks. Visible under `--reporter=verbose`; the assertion below
    // is what gates the build either way.
    console.log(
      `gauntlet targets: ${derived.length} derived, ${attacked} attacked, ${exempt} exempt ` +
        `(read ${counts.read}, list ${counts.list}, write ${counts.write}, credential ${counts.credential})`,
    );
    expect(attacked + exempt).toBe(derived.length);
  });

  // ── SC-014: THE COUNT MOVED BY EXACTLY WHAT THIS FEATURE ADDS ──────────────
  //
  // Chapter 3.12 closed at **24** derived targets, recorded in
  // `specs/033-chapter-3-12/baseline.txt` and re-measured at the start of this
  // feature (T008). Chapters 3.15 and 3.16 add fourteen routes, so the closing
  // number is 38.
  //
  // A NUMBER RATHER THAN A DELTA, because a delta cannot fail: `after - before`
  // computed from the same run is an identity. This is the figure a reader can
  // check against the route table, and the route table lists which fourteen.
  it("has grown from chapter 3.12's 24 by exactly the routes this feature adds", () => {
    // The routes built so far. This assertion moves ONE line per phase, which is
    // the point: a phase that adds a route and forgets to classify it fails the
    // test above, and a phase that adds a route nobody planned fails this one.
    const BUILT_SO_FAR = 10;
    expect(derived.length).toBe(24 + BUILT_SO_FAR);
  });

  it("leaves nothing exempt by omission (FR-033a)", () => {
    // Every exempt entry carries a reason — asserted above — and every DERIVED
    // target matches an entry. What this adds is the direction that catches a route
    // quietly dropped from the classification list: the entry count and the derived
    // count are the same number, so a deletion here fails rather than reducing
    // coverage silently.
    expect(CLASSIFICATIONS.length).toBe(derived.length);
  });
});
