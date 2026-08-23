import { describe, expect, it } from "vitest";

import { classifyRow, SPINE_TABLES } from "./catalogue";

// The classification's four arms, driven with rows made up here rather than with
// rows a database happens to hold (chapter 3.12, FR-040).
//
// The one that matters is `null`. It executes only when somebody adds a table with
// no tenant path — which is the state `tenant-scope.itest.ts` exists to prevent —
// so against a healthy database it is the one arm nothing can reach. T042 proved it
// fires by creating a scratch table by hand; this proves it without a database and
// without a hand.

const row = (over: Partial<Parameters<typeof classifyRow>[0]>) => ({
  table_name: "made_up",
  has_environment_id: false,
  fk_targets: null,
  ...over,
});

describe("a table's tenant path", () => {
  it("is direct when it carries environment_id", () => {
    expect(classifyRow(row({ has_environment_id: true }))).toEqual({
      table: "made_up",
      path: "direct",
      via: [],
    });
  });

  it("is a hop when a foreign key reaches a direct table", () => {
    expect(classifyRow(row({ fk_targets: ["channels", "users"] }))).toEqual({
      table: "made_up",
      path: "hop",
      via: ["channels", "users"],
    });
  });

  it("prefers direct over hop when a table has both", () => {
    // The ordering the function's own comment argues for: a spine table that
    // gains `environment_id` should report `direct` so its SPINE entry becomes
    // visibly wrong rather than quietly ignored.
    const both = classifyRow(row({ has_environment_id: true, fk_targets: ["channels"] }));
    expect(both.path).toBe("direct");
  });

  it("is spine for a listed table, and carries its reason", () => {
    const result = classifyRow(row({ table_name: "organisations" }));
    expect(result.path).toBe("spine");
    expect(result.reason).toBeTruthy();
  });

  it("IS NULL for a table with no path at all", () => {
    expect(classifyRow(row({ table_name: "t042_scratch" }))).toEqual({
      table: "t042_scratch",
      path: null,
      via: [],
    });
  });

  it("gives every spine table a reason", () => {
    for (const name of SPINE_TABLES) {
      expect(classifyRow(row({ table_name: name })).reason, name).toBeTruthy();
    }
  });
});
