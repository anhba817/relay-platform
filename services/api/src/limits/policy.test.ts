import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AUTH_FAILURES_PER_MINUTE,
  DEFAULT_LIMITS,
  WINDOW_MS,
  authFailureThreshold,
} from "./policy";

// The numbers, and what happens when someone fat-fingers the one that is
// configurable (chapter 3.8).

describe("authFailureThreshold", () => {
  const previous = process.env["RELAY_AUTH_FAILURES_PER_MINUTE"];
  afterEach(() => {
    if (previous === undefined) delete process.env["RELAY_AUTH_FAILURES_PER_MINUTE"];
    else process.env["RELAY_AUTH_FAILURES_PER_MINUTE"] = previous;
  });

  const withEnv = (value: string) => {
    process.env["RELAY_AUTH_FAILURES_PER_MINUTE"] = value;
    return authFailureThreshold();
  };

  it("uses the documented default when nothing is set", () => {
    delete process.env["RELAY_AUTH_FAILURES_PER_MINUTE"];
    expect(authFailureThreshold()).toBe(DEFAULT_AUTH_FAILURES_PER_MINUTE);
  });

  it("honours a configured threshold", () => {
    expect(withEnv("3")).toBe(3);
  });

  it("FALLS BACK TO THE DEFAULT for anything that is not a positive number", () => {
    // The failure mode this is protecting against is not exotic. `parseInt`
    // returns NaN for "ten" and 0 for "0", and either would be silently
    // catastrophic in a different direction: NaN makes every comparison false,
    // so the limiter never triggers; 0 makes it trigger on the first failed
    // auth, locking out an address that mistyped a password once.
    //
    // A misconfigured security control that fails silently is worse than one
    // that is absent, because nobody looks for it.
    for (const bad of ["ten", "", "0", "-1", "NaN"]) {
      expect(withEnv(bad)).toBe(DEFAULT_AUTH_FAILURES_PER_MINUTE);
    }
  });
});

describe("the defaults themselves", () => {
  it("are the numbers the chapter derived, not round ones", () => {
    // Pinned so a change has to be deliberate. Each was re-derived against
    // NFR-SCL and NFR-PRF (research R26); the chapter states the derivation and
    // this asserts the result.
    expect(DEFAULT_LIMITS).toEqual({ rest: 600, send: 600, connect: 3_000 });
    expect(DEFAULT_AUTH_FAILURES_PER_MINUTE).toBe(10);
    // One minute, because every limit above is stated per minute and a window
    // that did not match the unit would need a second number to explain it.
    expect(WINDOW_MS).toBe(60_000);
  });
});
