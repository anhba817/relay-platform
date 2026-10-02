import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { deriveTargets, targetKey, type DerivedTarget } from "../isolation/targets";
import { ACTION, MODERATION_ROUTES } from "./moderation-routes";

// FR-003 — THE SET IS DERIVED FROM THE RUNNING ROUTER, NOT MAINTAINED BY HAND.
//
// A route added later with no decision about it fails here rather than passing silently,
// which is the whole value of the mechanism (SC-004). `isolation/targets.ts` states the
// property this copies: *"A derived target matching no entry fails the suite, and an entry
// matching no derived target fails it too — the second direction is the one that catches a
// stale exemption after a rename."*
//
// AND THE DERIVATION HAS A FAILURE MODE A TYPED LIST DOES NOT: it can return nothing and
// pass. Express 5 renamed `_router` to `router`; a rename that broke this would leave the
// comparison green over an empty list, which is worse than the hand-written list it
// replaces because a hand-written list at least looks wrong when you read it. So the first
// test asks whether it looked, before any comparison trusts it.

/** Mutating, and tenant-reachable. Everything this file decides about. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function owedADecision(derived: readonly DerivedTarget[]): string[] {
  return derived
    .filter((t) => MUTATING.has(t.method.toUpperCase()))
    // `/internal/` IS OUTSIDE BY CONSTRUCTION RATHER THAN BY DECISION. A platform
    // principal carries no environment (chapter 4.4), so its action cannot be scoped to a
    // tenant and cannot appear in a tenant's read. *Outside by construction* and *decided
    // to be outside* are different claims and only one of them needs a reason.
    .filter((t) => !t.path.startsWith("/internal/"))
    .map(targetKey)
    .sort();
}

describe("every mutating route a tenant can reach is classified (FR-003, SC-004)", () => {
  let app: INestApplication;
  let derived: DerivedTarget[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    derived = deriveTargets(app.getHttpAdapter().getInstance()).targets;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("derived something to compare against", () => {
    // THE PROBE THAT SAYS THE INSTRUMENT LOOKED. Five gate scripts in this project have
    // exited 0 on an absent corpus, and a both-directions comparison of two empty sets is
    // the same zero wearing a tick.
    expect(derived.length).toBeGreaterThan(0);
    expect(owedADecision(derived).length).toBeGreaterThan(0);
  });

  it("classifies every one of them — a route with no entry fails here", () => {
    const unclassified = owedADecision(derived).filter(
      (key) => !(key in MODERATION_ROUTES),
    );
    expect(
      unclassified,
      `these routes exist and nobody decided whether they are moderation: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("and the other direction — an entry naming no route fails here", () => {
    // THE HALF A NEW MECHANISM FORGETS. Without it a route renamed in a later chapter
    // leaves a classification behind that reads as a decision and governs nothing, and
    // the suite stays green because every REAL route still has an entry.
    const owed = new Set(owedADecision(derived));
    const stale = Object.keys(MODERATION_ROUTES).filter((key) => !owed.has(key));
    expect(
      stale,
      `these entries name no route the application serves: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("every ACTION the repository writes is a route that is in the set", () => {
    // THE THIRD DIRECTION, and it is about the WRITE side rather than the list. A name in
    // `ACTION` that is classified `not-moderation` would be an entry the platform records
    // for an action it has decided is not moderation — a disagreement between the list and
    // the code that no comparison of the list against the router can see.
    for (const [name, key] of Object.entries(ACTION)) {
      expect(MODERATION_ROUTES[key], `ACTION.${name} is classified not-moderation`).not.toBe(
        "not-moderation",
      );
    }
  });

  it("and every route in the set has a writer, or is the one that has none by design", () => {
    // THE FOURTH, which is the one that cannot be fully automated and is still worth
    // asking. A `moderation` route with no `ACTION` name is a route classified as owing an
    // entry that nothing writes — the shape chapter 4.6 found when a rollup had a producer
    // and no reader, and chapter 4.16 found again with a column nothing read.
    const written = new Set(Object.values(ACTION) as string[]);
    const owing = Object.entries(MODERATION_ROUTES)
      .filter(([, kind]) => kind !== "not-moderation")
      .map(([key]) => key);
    const unwritten = owing.filter((key) => !written.has(key));
    expect(
      unwritten,
      `classified as owing an entry and nothing writes one: ${unwritten.join(", ")}`,
    ).toEqual([]);
  });
});
