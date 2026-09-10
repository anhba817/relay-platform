import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// THE DRAIN EXEMPTION, CHECKED AGAINST THE TREE RATHER THAN AGAINST A SECOND LIST.
//
// `DRAIN_EXEMPT_TESTS` excuses six suites from a rule that forbids importing a global
// admin function into an integration test. The rule catches an unlisted file loudly.
// What it cannot catch is a LISTED file that stopped importing one — the exemption
// simply never fires — so the list can only grow, and a stale entry holds a standing
// exemption over a file that no longer needs one.
//
// PUBLISHED CHECKS THIS BY COMPARING TWO LISTS, and that comparison is not available
// here. Its `lists-agree.test.ts` asserts that `DRAIN_EXEMPT_TESTS` and
// `packages/test-harness/src/exempt.ts` name the same files, which is true of a guard
// array holding nine tables including the webhook ones. This tree's guard grew per
// chapter by SUBJECT — seven tables, none of them touched by these drains — so
// `EXEMPT_FILES` names one file and would disagree with this list by five. Asserting
// the agreement would mean widening one list to match the other for the sake of a test,
// which is the tail wagging the guard.
//
// So both directions are asserted against the tree, which is what the lists were ever
// standing in for: every listed suite still imports a restricted function, and every
// suite that imports one is listed.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CONFIG = join(ROOT, "eslint.config.mjs");

function config(): string {
  return readFileSync(CONFIG, "utf8");
}

/** A named const's body, read by name. The same parse `driver-exempt.test.ts` uses,
 * and for the same reason: a position is a claim about layout. */
function block(name: string): string {
  const text = config();
  const start = text.indexOf(`const ${name} = `);
  if (start === -1) {
    throw new Error(`eslint.config.mjs has no ${name} — the shape this test reads changed`);
  }
  const rest = text.slice(start);
  const ends = ["\n};", "\n];"].map((e) => rest.indexOf(e)).filter((i) => i !== -1);
  if (ends.length === 0) throw new Error(`${name} is not terminated the way this test reads it`);
  return rest.slice(0, Math.min(...ends));
}

const exempt = (): string[] =>
  [...block("DRAIN_EXEMPT_TESTS").matchAll(/"([^"]+\.itest\.ts)"/g)].map((m) => m[1]!);

/** The restricted function names, read out of the rule rather than restated — so
 * adding a seventh does not need this file edited. */
const drains = (): string[] =>
  [...block("DRAIN_NAMES").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

/** Every `*.itest.ts` in the workspace. Walked, not listed: a suite added under a new
 * directory arrives here without anyone remembering. */
function integrationSuites(dir = ROOT, out: string[] = []): string[] {
  const skip = new Set(["node_modules", ".git", "dist", "coverage", ".turbo", "build"]);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) integrationSuites(full, out);
    else if (e.name.endsWith(".itest.ts")) out.push(full.slice(ROOT.length + 1).replace(/\\/g, "/"));
  }
  return out;
}

/** Does this file import one of the restricted names FROM the repository module? The
 * rule matches the specifier as written, so both spellings are read the same way. */
function importsADrain(rel: string, names: string[]): string[] {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.\.?\/(?:db\/)?repository)[^"]*"/g)]
    .map((m) => m[1]!)
    .join(",");
  return names.filter((n) => new RegExp(`\\b${n}\\b`).test(imports));
}

describe("the drain exemption is checked in both directions", () => {
  it("parses a non-empty list and non-empty set of restricted names", () => {
    // Both parses failing open would make every assertion below vacuous, which is the
    // way a check like this normally dies.
    expect(exempt().length, "no exempt suites parsed").toBeGreaterThan(0);
    expect(drains().length, "no restricted names parsed").toBeGreaterThan(0);
    expect(integrationSuites().length, "no integration suites found").toBeGreaterThan(0);
  });

  it("names a file that exists, for every exempt suite", () => {
    for (const path of exempt()) {
      expect(existsSync(join(ROOT, path)), `${path} is exempt and absent`).toBe(true);
    }
  });

  it("still imports a restricted function, for every exempt suite", () => {
    // THE STALE-ENTRY CHECK. A suite that no longer drives a drain does not need the
    // exemption, and leaving it listed means the next edit to that file may reach for
    // one and nothing will say so.
    const names = drains();
    const stale = exempt().filter((p) => importsADrain(p, names).length === 0);
    expect(stale, `exempt from the drain rule and importing none of it: ${stale.join(", ")}`)
      .toEqual([]);
  });

  it("lists every integration suite that imports one", () => {
    // The direction the linter also covers — but it covers it by going red on a build
    // nobody has run yet. Here the list's completeness is a fact somebody can read.
    const names = drains();
    const listed = new Set(exempt());
    const missing = integrationSuites().filter(
      (p) => !listed.has(p) && importsADrain(p, names).length > 0,
    );
    expect(missing, `imports a global drain and is not exempt: ${missing.join(", ")}`).toEqual([]);
  });
});
