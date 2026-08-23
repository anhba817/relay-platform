import { describe, expect, it } from "vitest";

import { deriveTargets } from "./targets";

// THE DERIVATION'S SHAPE-HANDLING, driven with fakes.
//
// `targets.itest.ts` runs `deriveTargets` against a real Nest application, which
// is the assertion that matters — and a real application has exactly one router
// shape, so the fallbacks for the others are unreachable there. Express 4 exposed
// `_router`, Express 5 exposes `router`, and a future adapter may expose neither;
// the branch that reports `none` is the one a reader of a failure most needs to be
// working, because it is what turns "no routes found" into "no router found".

const route = (path: string, methods: Record<string, boolean>) => ({ route: { path, methods } });

describe("deriving targets from whatever the adapter exposes", () => {
  it("reads Express 5's `router`", () => {
    const result = deriveTargets({
      router: { stack: [route("/v1/x", { get: true })] },
    });
    expect(result.property).toBe("router");
    expect(result.targets).toEqual([{ method: "GET", path: "/v1/x" }]);
  });

  it("falls back to Express 4's `_router`", () => {
    const result = deriveTargets({
      _router: { stack: [route("/v1/y", { post: true })] },
    });
    expect(result.property).toBe("_router");
    expect(result.targets).toEqual([{ method: "POST", path: "/v1/y" }]);
  });

  it("says `none` rather than pretending the surface is empty", () => {
    // The distinction the suite depends on: an empty target list from a found
    // router is a clean surface, and an empty list from no router at all is a
    // broken derivation. Only this field tells them apart.
    const result = deriveTargets({});
    expect(result.property).toBe("none");
    expect(result.targets).toEqual([]);
  });

  it("counts middleware layers, which have no route", () => {
    const result = deriveTargets({
      router: { stack: [{}, {}, route("/v1/z", { delete: true })] },
    });
    expect(result.middlewareLayers).toBe(2);
    expect(result.targets).toEqual([{ method: "DELETE", path: "/v1/z" }]);
  });

  it("takes only the verbs a layer actually answers", () => {
    // Express marks every verb on the layer and flags the live ones. Treating the
    // keys as the answer would invent a target per HTTP verb per route.
    const result = deriveTargets({
      router: { stack: [route("/v1/w", { get: true, post: false, put: false })] },
    });
    expect(result.targets).toEqual([{ method: "GET", path: "/v1/w" }]);
  });

  it("handles a layer with a route but no methods, and one with no path", () => {
    const result = deriveTargets({
      router: { stack: [{ route: { path: "/v1/none" } }, { route: { methods: { get: true } } }] },
    });
    expect(result.targets).toEqual([{ method: "GET", path: "" }]);
  });
});
