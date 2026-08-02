import { describe, expect, it } from "vitest";

import { CLOSE_CODES, ERROR_CODES } from "./codes.js";

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
