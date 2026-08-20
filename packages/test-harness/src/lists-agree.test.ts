import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EXEMPT_FILES } from "./exempt.js";

// T026 says the two exemption lists "must agree". A sentence in two comments is
// exactly the kind of convention this feature exists to replace, so it is checked
// here instead: `eslint.config.mjs` and `exempt.ts` are edited by different people
// for different reasons, and a file exempt from the linter but not the trigger — or
// the reverse — is a trap for whoever adds the seventh instance.

const CONFIG = new URL("../../../eslint.config.mjs", import.meta.url);

/** The ignores of the block that restricts the global admin functions, which is
 * the only block keyed on `**\/*.itest.ts`. */
function lintIgnores(): string[] {
  const src = readFileSync(CONFIG, "utf8");
  const block = src.slice(src.indexOf('files: ["**/*.itest.ts"]'));
  const start = block.indexOf("ignores: [");
  // Measured from `start`, not from the top of the block: the `files:` line above
  // ends in `"],`, so an absolute `indexOf("],")` lands before the ignores begin
  // and the slice comes back empty — which the second test in this file exists to
  // catch, and did.
  const ignores = block.slice(start, start + block.slice(start).indexOf("],"));
  return [...ignores.matchAll(/"([^"]+\.itest\.ts)"/g)].map((m) => m[1]!);
}

describe("the two exemption lists", () => {
  it("name the same files", () => {
    expect([...lintIgnores()].sort()).toEqual(
      EXEMPT_FILES.map((e) => e.path).sort(),
    );
  });

  it("is reading a real list and not an empty match", () => {
    // The assertion above passes trivially if the regex finds nothing and
    // EXEMPT_FILES is somehow empty. Both halves have to be non-empty for the
    // comparison to mean anything.
    expect(lintIgnores().length).toBeGreaterThan(0);
    expect(EXEMPT_FILES.length).toBeGreaterThan(0);
  });
});
