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
//
// AND THE THIRD ONE ARRIVED, WHICH TESTED THAT CLAIM. The rate-limit chapter
// restricted `ioredis`; the two checks that read the module names off the rule
// picked it up with no edit here, exactly as intended. The last check needed one,
// because it is not about modules at all — it is about which entries may be
// PATTERNS, and the counter store is a second data-access layer.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CONFIG = join(ROOT, "eslint.config.mjs");

function config(): string {
  return readFileSync(CONFIG, "utf8");
}

/** The paths the config exempts from the driver rule, read off the `DRIVER_EXEMPT`
 * const. Parsed, not restated.
 *
 * BY NAMED CONST AND NOT BY POSITION, since the gauntlet chapter composed the rule
 * sets. The list used to live inline in the all-TypeScript block's `ignores` and was read
 * from a marker comment to the next `]`; it is hoisted now, because a second block
 * has to reference the same list rather than repeat it. A position is a claim about
 * layout, and this file has already been wrong about layout once. */
function block(name: string): string {
  const text = config();
  const start = text.indexOf(`const ${name} = `);
  if (start === -1) {
    throw new Error(`eslint.config.mjs has no ${name} — the shape this test reads changed`);
  }
  const rest = text.slice(start);
  // THE NEARER TERMINATOR, NOT A PREFERRED ONE. This asked for `\n};` first and fell
  // back to `\n];`, which reads an ARRAY const to the end of the next OBJECT const —
  // so `DRIVER_EXEMPT` swallowed `DRAIN_EXEMPT_TESTS` whole and this file reported
  // `outbox.itest.ts` as driver-exempt and importing nothing restricted. It was right
  // about the import and wrong about the list, which is the failure that sends somebody
  // to the wrong file.
  const ends = ["\n};", "\n];"].map((e) => rest.indexOf(e)).filter((i) => i !== -1);
  if (ends.length === 0) throw new Error(`${name} is not terminated the way this test reads it`);
  return rest.slice(0, Math.min(...ends));
}

function exemptPaths(): string[] {
  return [...block("DRIVER_EXEMPT").matchAll(/"([^"]+\.ts)"/g)].map((m) => m[1]!);
}

/** The module names the DRIVER rule restricts, read off `DRIVER_AND_ENGINE`.
 *
 * THIS USED TO SCAN FORWARD FROM THE FIRST `"no-restricted-imports"` to the next
 * `paths: [ … ], patterns:`. After the hoisting the first occurrence is
 * `["error", DRIVER_AND_ENGINE]`, and the next matching `paths:` belongs to the
 * UNION block — whose entries are spreads, carrying no `name:` at all. The parse
 * returned `[]` and every check reading it went vacuous, which the first assertion
 * below catches and is the only reason this was a nuisance rather than a hole. */
function restricted(): string[] {
  return [...block("DRIVER_AND_ENGINE").matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]!);
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

  it("exempts the two data-access layers as directories and everything else by path", () => {
    // BY NAME, AND THE TWO EARLIER SHAPES ARE WHY. This read a window around the rule
    // (`indexOf("ignores: [", indexOf("no-restricted-imports") - 2000)`) until a comment
    // grew the block past 2,000 characters and the search silently found the NEXT
    // `ignores` and reported `[]`. It then scanned backwards from the rule, until the
    // list was hoisted out of the block entirely and there was no `ignores: [` to find.
    // Both failures are the same one: a position is a claim about layout.
    const entries = [...block("DRIVER_EXEMPT").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    // THE POSITIVE CONTROL. Every assertion below is about which of these are globs, and
    // a parse that found nothing would satisfy all of them.
    expect(entries.length, "parsed no entries at all — this test is broken, not passing")
      .toBeGreaterThan(0);
    // TWO directory patterns and they are the two data-access LAYERS: `db/**` for the
    // driver and the engine, `limits/**` for the counter store, each of them the thing
    // the rule carves out rather than a file that happens to need it. Any other pattern
    // would silently absorb the next file added under it, which is what this list
    // exists instead of — and the rate-limit chapter arrived with twelve older Redis
    // clients in the tree, every one of them listed by path above rather than swept up
    // by `services/gateway/src/**`.
    expect(entries.filter((g) => g.includes("*"))).toEqual([
      "services/api/src/db/**",
      "services/api/src/limits/**",
    ]);
  });
});
