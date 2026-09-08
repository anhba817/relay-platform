import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// THE DIRECTION `no-restricted-imports` CANNOT SEE.
//
// The rule catches an unlisted file that imports the driver — that is its job and
// it does it loudly. What it cannot catch is a LISTED file that stopped importing
// one: the exemption simply never fires, and nothing anywhere goes red. So the
// list can only grow, and a stale entry holds a standing exemption over a file
// that no longer needs one.
//
// There is no second list to compare against. What the list has to agree with is
// the TREE, which makes the assertion here read the config's own text — and the
// restricted module names are read out of the rule rather than restated, so
// adding a third restricted module does not need this file edited.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CONFIG = join(ROOT, "eslint.config.mjs");

function config(): string {
  return readFileSync(CONFIG, "utf8");
}

/** The paths the config exempts from the driver rule, read off the `ignores` array
 * after the DRIVER_EXEMPT marker. Parsed, not restated. */
function exemptPaths(): string[] {
  const text = config();
  const marker = text.indexOf("// DRIVER_EXEMPT");
  if (marker === -1) {
    throw new Error(
      "eslint.config.mjs has no DRIVER_EXEMPT marker — the shape this test reads changed",
    );
  }
  const end = text.indexOf("]", marker);
  return [...text.slice(marker, end).matchAll(/"([^"]+\.ts)"/g)].map((m) => m[1]!);
}

/** The module names the rule restricts, read off its `paths` entries. */
function restricted(): string[] {
  const text = config();
  const block = /"no-restricted-imports":[\s\S]*?paths:\s*\[([\s\S]*?)\],\s*patterns:/.exec(text);
  if (block === null) {
    throw new Error(
      "eslint.config.mjs's no-restricted-imports rule is not shaped the way this test reads it",
    );
  }
  return [...block[1]!.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the driver exemption is checked in both directions", () => {
  it("parses a non-empty list of exempt paths and restricted modules", () => {
    // Both parses failing open would make every assertion below vacuous, which is
    // the way a check like this normally dies.
    expect(exemptPaths().length, "no exempt paths parsed").toBeGreaterThan(0);
    expect(restricted().length, "no restricted modules parsed").toBeGreaterThan(0);
  });

  it("names a file that exists, for every exempt path", () => {
    for (const path of exemptPaths()) {
      expect(existsSync(join(ROOT, path)), `${path} is exempt and absent`).toBe(true);
    }
  });

  it("still imports a restricted module, for every exempt path", () => {
    // THE STALE-ENTRY CHECK. A file that no longer touches the driver does not
    // need the exemption, and leaving it listed means the next edit to that file
    // may reach for `pg` and nothing will say so.
    const modules = restricted();
    for (const path of exemptPaths()) {
      const text = readFileSync(join(ROOT, path), "utf8");
      const uses = modules.filter(
        (m) => text.includes(`from "${m}"`) || text.includes(`from "${m}/`),
      );
      expect(uses, `${path} is exempt from the driver rule and imports none of ${modules.join(", ")}`)
        .not.toEqual([]);
    }
  });

  it("exempts the repository layer as a directory and everything else by path", () => {
    const text = config();
    // FOUND BY SCANNING BACK FROM THE RULE, NOT BY A WINDOW. This read `indexOf("ignores:
    // [", indexOf("no-restricted-imports") - 2000)` and the 2000 was the whole check: the
    // block grew by a comment, the real `ignores` fell 2,027 characters before the anchor
    // — 27 outside the window — and the search silently found the NEXT one instead and
    // reported `[]`. An empty list is a legitimate-looking answer, so nothing said broken.
    const anchor = text.indexOf("no-restricted-imports");
    expect(anchor, "the rule this test reads is not in the config").toBeGreaterThan(-1);
    const start = text.lastIndexOf("ignores: [", anchor);
    expect(start, "no ignores list precedes the rule").toBeGreaterThan(-1);
    const entries = [...text.slice(start, text.indexOf("]", start)).matchAll(/"([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    // THE POSITIVE CONTROL. Every assertion below is about which of these are globs, and
    // a parse that found nothing would satisfy all of them.
    expect(entries.length, "parsed no entries at all — this test is broken, not passing")
      .toBeGreaterThan(0);
    // The directory pattern is legitimate — `services/api/src/db` IS the layer the
    // rule carves out. Any OTHER pattern would silently absorb the next file added
    // under it, which is the thing this list exists instead of.
    expect(entries.filter((g) => g.includes("*"))).toEqual(["services/api/src/db/**"]);
  });
});
