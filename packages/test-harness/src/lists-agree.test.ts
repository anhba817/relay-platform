import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EXEMPT_FILES } from "./exempt.js";

// T026 says the two exemption lists "must agree". A sentence in two comments is
// exactly the kind of convention this feature exists to replace, so it is checked
// here instead: `eslint.config.mjs` and `exempt.ts` are edited by different people
// for different reasons, and a file exempt from the linter but not the trigger — or
// the reverse — is a trap for whoever adds the seventh instance.

const CONFIG = new URL("../../../eslint.config.mjs", import.meta.url);

/** The drain-exempt list as `eslint.config.mjs` declares it.
 *
 * READ FROM THE NAMED CONST, not from a block's inline `ignores`. Chapter 3.12
 * restructured that file into three blocks — the two exemption lists are
 * different files and a block has one `ignores`, so the lists became
 * `DRAIN_EXEMPT_TESTS` and `DRIVER_EXEMPT_TESTS` and the blocks spread them.
 *
 * This function used to slice from `files: ["**\/*.itest.ts"]` to the first
 * `],`, and after the restructuring it matched an `ignores` containing two
 * spreads and no string at all: the comparison below then read `[] vs [6]`, which
 * is the failure that brought this here. Parsing a named array is also less
 * fragile than parsing a position — the old comment on this function was already
 * an apology for the position.
 */
function drainExemptInLintConfig(): string[] {
  const src = readFileSync(CONFIG, "utf8");
  const start = src.indexOf("const DRAIN_EXEMPT_TESTS = [");
  if (start === -1) throw new Error("DRAIN_EXEMPT_TESTS not found in eslint.config.mjs");
  const body = src.slice(start, start + src.slice(start).indexOf("\n];"));
  return [...body.matchAll(/"([^"]+\.itest\.ts)"/g)].map((m) => m[1]!);
}

/** And the block for `**\/*.itest.ts` has to actually USE it. A list nothing
 * spreads is a list that agrees with `exempt.ts` and exempts nobody. */
function lintConfigSpreadsIt(): boolean {
  const src = readFileSync(CONFIG, "utf8");
  return /ignores:\s*\[[^\]]*\.\.\.DRAIN_EXEMPT_TESTS/.test(src);
}

describe("the two exemption lists", () => {
  it("name the same files", () => {
    expect([...drainExemptInLintConfig()].sort()).toEqual(
      EXEMPT_FILES.map((e) => e.path).sort(),
    );
  });

  it("is reading a real list and not an empty match", () => {
    // The assertion above passes trivially if the regex finds nothing and
    // EXEMPT_FILES is somehow empty. Both halves have to be non-empty for the
    // comparison to mean anything.
    expect(drainExemptInLintConfig().length).toBeGreaterThan(0);
    expect(EXEMPT_FILES.length).toBeGreaterThan(0);
    // And the list is wired in, not merely declared.
    expect(lintConfigSpreadsIt()).toBe(true);
  });
});
