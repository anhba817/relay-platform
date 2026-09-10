import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
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
// The gauntlet attacks a list it derives from the running application rather than one
// somebody typed, because the fault NFR-SEC-09 exists to prevent is a route that exists
// and is unattacked. But a derivation has a failure mode a typed list does not: IT CAN
// RETURN NOTHING AND PASS. Express 5 renamed `_router` to `router`; an upgrade that
// renamed it again would leave this suite green while it attacked zero endpoints, which
// is worse than the hand-written list it replaces, because a hand-written list at least
// looks wrong when you read it.
//
// So the derivation is checked before it is used: it found a router, it found routes, it
// found the route we know is there, and every target it found is classified exactly once.

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
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("found a router at all, and says which property answered", () => {
    expect(property).not.toBe("none");
    expect(["router", "_router"]).toContain(property);
  });

  it("found routes — an empty list is a broken derivation, not a clean surface", () => {
    expect(derived.length).toBeGreaterThan(0);
    // Middleware layers exist in any mounted express app. Zero of them alongside zero
    // routes is the signature of reading the wrong object rather than of a small api.
    expect(middlewareLayers).toBeGreaterThan(0);
  });

  it("found the route that has existed since chapter 2.2", () => {
    expect(derived.map(targetKey)).toContain(CANARY_TARGET);
  });

  it("classifies every derived target exactly once", () => {
    const entries = new Map<string, number>();
    for (const c of CLASSIFICATIONS) {
      entries.set(targetKey(c), (entries.get(targetKey(c)) ?? 0) + 1);
    }
    const unclassified = derived.map(targetKey).filter((k) => !entries.has(k));
    const duplicated = [...entries].filter(([, n]) => n > 1).map(([k]) => k);
    // Named in the failure, because "9 !== 10" sends a reader to count rows.
    expect({ unclassified, duplicated }).toEqual({ unclassified: [], duplicated: [] });
  });

  it("has no classification entry that matches no derived target", () => {
    const found = new Set(derived.map(targetKey));
    const stale = CLASSIFICATIONS.map(targetKey).filter((k) => !found.has(k));
    // THIS IS THE DIRECTION THAT CATCHES A RENAME. A route renamed with its exemption
    // left behind is a route nobody attacks and nobody misses.
    expect(stale).toEqual([]);
  });

  it("gives every exempt entry a reason", () => {
    const reasonless = CLASSIFICATIONS.filter(
      (c) => c.shape === "exempt" && (!c.because || c.because.trim() === ""),
    ).map(targetKey);
    expect(reasonless).toEqual([]);
  });

  it("accounts for every derived target as attacked or exempt", () => {
    const counts = shapeCounts(CLASSIFICATIONS);
    // EVERYTHING THAT IS NOT EXEMPT, DERIVED — not `read + write + credential`.
    //
    // `shapeCounts` returns `Record<Shape, number>`, so adding a shape stopped that
    // function compiling and named the line. This sum is arithmetic over three
    // properties, which no type checks: `list` arrived, the record grew, and the
    // total silently stopped including it. `expected 17 to be 18` — a route
    // classified, attacked, and counted as neither.
    //
    // The exemption is named because it is the one class that is deliberately not
    // attacked. Everything else is, whatever it is called.
    const attacked = Object.entries(counts)
      .filter(([shape]) => shape !== "exempt")
      .reduce((n, [, count]) => n + count, 0);
    const breakdown = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([shape, count]) => `${shape} ${count}`)
      .join(", ");
    // A number nobody can see is a number nobody checks. Visible under
    // `--reporter=verbose`; the assertion below is what gates the build either way.
    console.log(
      `gauntlet targets: ${derived.length} derived, ${attacked} attacked, ` +
        `${counts.exempt} exempt (${breakdown})`,
    );
    expect(attacked + counts.exempt).toBe(derived.length);
  });

  // ── SC-014: EVERY ROUTE THIS CHAPTER ADDS, NAMED ──────────────────────────
  //
  // A LIST RATHER THAN A NUMBER, and the number it replaced is why. It read
  // `expect(derived.length).toBe(24 + BUILT_SO_FAR)` — twenty-four being another
  // chapter's closing count, carried here as a literal and true of a tree this one
  // is not. It failed `expected 17 to be 30`, and neither figure told a reader
  // which route was missing.
  //
  // Named, the failure says which. And the direction that matters is both: a route
  // added and never classified fails the accounting test above; a route classified
  // and never built fails this one, because the derivation reads the running
  // router.
  it("derives every route the chapters since have added, and nothing else new", () => {
    // THE LIST GROWS BY CHAPTER AND THE ASSERTION DOES NOT MOVE. Each chapter that
    // adds a route adds its key here, so a route added and never classified fails the
    // accounting test above and a route classified and never built fails this one —
    // the derivation reads the running router either way.
    const ADDED = [
      // The channel a customer controls.
      "GET /v1/channels/:channelId",
      "POST /v1/channels/:channelId/join",
      "POST /v1/channels/:channelId/members/remove",
      "PATCH /v1/channels/:channelId/members/:userExternalId",
      "POST /v1/channels/:channelId/archive",
      "DELETE /v1/channels/:channelId/archive",
      // This chapter's, and the first `list` shape the classification has had.
      "GET /v1/users/:externalId/channels",
      "PUT /v1/users/:externalId/channels/:channelId/read",
      "GET /v1/users/:externalId",
      "PATCH /v1/users/:externalId",
      "POST /v1/users",
      "DELETE /v1/users/:externalId",
      "POST /v1/users/:externalId/ban",
      "DELETE /v1/users/:externalId/ban",
      // THE REVISIONS CHAPTER, AND IT CAUGHT ITS OWN MISTAKE IN BOTH DIRECTIONS AT
      // ONCE. Both keys went into `targets.ts` before the second route was written, so
      // one run named `GET …/:messageId/edits` as an entry matching no derived target —
      // the direction a rename breaks — while the accounting test above named the other.
      "GET /v1/channels/:channelId/messages/:messageId/edits",
      "PATCH /v1/channels/:channelId/messages/:messageId",
      "DELETE /v1/channels/:channelId/messages/:messageId",
      // ── THE `/internal` SURFACE, WHICH THIS LIST HAD NEVER NAMED ────────────
      //
      // The metering chapter added its usage report here and filed the rest. This is
      // the rest: five routes on the router, classified in `targets.ts`, and absent
      // from the one assertion that catches a route CLASSIFIED AND NEVER BUILT.
      //
      // The gap cost nothing — the accounting test above catches the other direction,
      // and every one of these is on the router today. What it cost was the claim:
      // "each chapter that adds a route adds its key here" was false of five routes,
      // and a list that is quietly incomplete is weaker than the sentence describing
      // it. This chapter is the gauntlet's, so it is the one that owes the sweep.
      "POST /internal/usage/connections",
      "GET /internal/memberships",
      "POST /internal/dispatch/expand",
      "POST /internal/dispatch/material",
      "POST /internal/dispatch/outcome",
      "POST /internal/dispatch/replay",
    ];
    const keys = derived.map(targetKey);
    const missing = ADDED.filter((k) => !keys.includes(k));
    expect(missing, `classified here and not on the router: ${missing.join(", ")}`)
      .toEqual([]);
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
