import { describe, expect, it } from "vitest";

import { CLOSE_CODES, docsUrl, ERROR_CODES, ERROR_DOCS_BASE, type ErrorCode } from "./codes.js";

// The failure vocabulary stays coherent: EIR-WS-06's four classes are all
// present, exactly once, with distinct meanings — and error codes never
// collide or go blank as chapters add to the registry.

describe("close codes cover EIR-WS-06's four classes", () => {
  it("contains exactly 4001, 4002, 4008, 4009", () => {
    expect(Object.keys(CLOSE_CODES).map(Number).sort()).toEqual([
      4001, 4002, 4008, 4009,
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
