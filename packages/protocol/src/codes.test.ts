import { describe, expect, it } from "vitest";

import { CLOSE_CODES, docsUrl, ERROR_CODES, ERROR_DOCS_BASE, type ErrorCode } from "./codes.js";

// The failure vocabulary stays coherent: EIR-WS-06's four classes are all
// present, exactly once, with distinct meanings — and error codes never
// collide or go blank as chapters add to the registry.

describe("close codes cover EIR-WS-06's four classes", () => {
  // AND ONE MORE THAN FOUR, SINCE THE PREVIOUS CHAPTER. `4003` is a ban, which is none of
  // EIR-WS-06's classes: the token verifies, names a real user and is in date, and the
  // user is refused anyway. Reusing 4001 would tell a client to re-authenticate, which
  // succeeds at minting a token and fails again at connect.
  //
  // THIS ASSERTION IS WHY THE NUMBER IS DELIBERATE. It failed on the build that added
  // 4003 — an exact-set assertion is the only kind that makes a new close code a decision
  // rather than an accident, and updating it is the act of making that decision.
  it("contains exactly 4001, 4002, 4003, 4008, 4009", () => {
    expect(Object.keys(CLOSE_CODES).map(Number).sort()).toEqual([
      4001, 4002, 4003, 4008, 4009,
    ]);
  });

  it("gives every code a distinct, non-empty meaning", () => {
    const meanings = Object.values(CLOSE_CODES);
    expect(new Set(meanings).size).toBe(meanings.length);
    for (const meaning of meanings) expect(meaning.length).toBeGreaterThan(0);
  });
});

describe("error codes stay unique and described", () => {
  it("has no duplicate or empty descriptions", () => {
    const descriptions = Object.values(ERROR_CODES);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const d of descriptions) expect(d.length).toBeGreaterThan(0);
  });

  it("uses snake_case machine-readable keys (EIR-API-04)", () => {
    for (const code of Object.keys(ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z_]*$/);
    }
  });
});

describe("every code the REST filter can emit is registered (FR-024)", () => {
  // The filter maps a status to a code when the thrower names none. Four of these
  // were absent from the registry and went out on the wire from chapter 2.2, each
  // with a `docs_url` derived from a code the reference could not document.
  //
  // NAMED HERE RATHER THAN IMPORTED, because `@relay/protocol` must not depend on a
  // service. That makes this list a second copy of the ladder — so it is asserted in
  // the direction that catches drift: the ladder is TYPED `ErrorCode`, which means a
  // code it emits and this registry lacks stops compiling in the api. This test
  // covers the other direction, that the four are not quietly deleted from here.
  const EMITTED_BY_STATUS = [
    "invalid_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "internal_error",
  ] as const;

  it.each(EMITTED_BY_STATUS)("registers %s", (code) => {
    expect(ERROR_CODES).toHaveProperty(code);
    expect(ERROR_CODES[code as ErrorCode]).not.toBe("");
  });
});

describe("the three refusals this chapter's channel adds", () => {
  // NAMED HERE RATHER THAN COUNTED. A `toHaveLength(13)` would go red for the right
  // reason on a deletion and for the wrong reason on any addition, so every later
  // chapter that adds a code would edit this number — and a number edited on every
  // change is a number nobody reads. What matters about these three is that they are
  // three and not one: a client acts differently on each.
  const ADDED = ["not_a_member", "channel_archived", "user_banned"] as const;

  it.each(ADDED)("registers %s with a description a client can act on", (code) => {
    expect(ERROR_CODES).toHaveProperty(code);
    expect(ERROR_CODES[code as ErrorCode]).not.toBe("");
  });

  it("keeps them distinct from forbidden, which is what they exist instead of", () => {
    // Reusing `forbidden` for all three is the design this chapter argues against, so
    // the assertion is that no two of them share a description with it or each other
    // — the failure mode is a copied line, not a missing key.
    const meanings = [...ADDED, "forbidden"].map((c) => ERROR_CODES[c as ErrorCode]);
    expect(new Set(meanings).size).toBe(meanings.length);
  });

  // THREE CLAIMS, THREE TITLES, and the reason is what a failure looks like from
  // outside the repository. One case asserting all three went red on the wording of
  // `not_a_member` under a title about bans and archives — a CI summary has no tree
  // to grep, so the title is the whole report.
  //
  // Asserting on wording is unusual and deliberate: these strings are the contract
  // `docs_url` resolves to, and a client's developer reads them rather than the code.

  it("says a ban is tenant-scope, not channel-scope", () => {
    expect(ERROR_CODES.user_banned).toMatch(/environment/);
  });

  it("says an archive leaves history readable", () => {
    expect(ERROR_CODES.channel_archived).toMatch(/history is still readable/);
  });

  it("never lets not_a_member announce that the channel exists", () => {
    // THE LEAK FR-003 FORBIDS, in the one place it can be written by accident. A
    // private channel the caller cannot see must answer the not-found envelope, so a
    // description saying "the channel exists and…" would put the oracle in the text
    // even when the status code is right.
    expect(ERROR_CODES.not_a_member).not.toMatch(/\bexists?\b/);
  });
});

describe("the docs URL is built in one place, with the code as the anchor", () => {
  it("appends the code VERBATIM — no slug transform, no case change", () => {
    for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
      expect(docsUrl(code)).toBe(`${ERROR_DOCS_BASE}/${code}`);
      expect(docsUrl(code).endsWith(`/${code}`)).toBe(true);
    }
  });

  it("gives every code a distinct URL", () => {
    const urls = (Object.keys(ERROR_CODES) as ErrorCode[]).map(docsUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
