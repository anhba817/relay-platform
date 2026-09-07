import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EXEMPT_FILES } from "./exempt.js";

// Feature 030 required the two DRAIN exemption lists to "must agree". A sentence in
// two comments is exactly the kind of convention that feature exists to replace, so it
// is checked here instead: `eslint.config.mjs` and `exempt.ts` are edited by different
// people for different reasons, and a file exempt from the linter but not the trigger —
// or the reverse — is a trap for whoever adds the seventh instance.
//
// THE SECOND DESCRIBE IN THIS FILE IS ABOUT A DIFFERENT LIST, and it took a while to
// notice. `gaps.md` carried an open item saying `DRIVER_EXEMPT_TESTS` and its
// counterpart "agree by somebody remembering" — and this file's existence made it look
// closed, because the filename says two exemption lists agree and the describe above
// says the same. It asserts the DRAIN pair. The driver list had nothing.
//
// Read the assertion, not the filename.

const CONFIG = new URL("../../../eslint.config.mjs", import.meta.url);

/** The drain-exempt list as `eslint.config.mjs` declares it.
 *
 * READ FROM THE NAMED CONST, not from a block's inline `ignores`. The isolation gauntlet
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

// ── the driver list (gaps.md 3.23-4) ────────────────────────────────────────────
//
// `DRIVER_EXEMPT_TESTS` HAS NO COUNTERPART LIST. That is the first thing to establish,
// because the gap item was written as though it did: what it must agree with is the
// TREE — the set of test files that genuinely import the driver, the query engine or
// the counter store.
//
// AND THE LINTER CHECKS ONE DIRECTION ONLY. A file that imports `pg` and is not listed
// fails the rule, loudly. A file that IS listed and imports none of them passes forever
// and says nothing, so the list can only grow. A stale entry is not cosmetic: it holds
// a standing exemption over a file that no longer needs one, and the next edit to that
// file may reintroduce raw access under a rule that has already been told to look away.
//
// This is `check-error-codes.mjs`'s lesson in a second place — compare both directions,
// and the direction nobody enforces is the one that rots.

/** The modules the driver rule restricts, READ FROM THE RULE. Restating them here
 * would be the two-lists defect this file exists to catch, one file over. */
function restrictedByTheRule(): { names: string[]; groups: string[] } {
  const src = readFileSync(CONFIG, "utf8");
  const start = src.indexOf("const DRIVER_AND_ENGINE = {");
  if (start === -1) throw new Error("DRIVER_AND_ENGINE not found in eslint.config.mjs");
  const body = src.slice(start, start + src.slice(start).indexOf("\n};"));
  return {
    names: [...body.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]!),
    groups: [...body.matchAll(/group:\s*\[([^\]]+)\]/g)].flatMap((m) =>
      [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!),
    ),
  };
}

function driverExemptInLintConfig(): string[] {
  const src = readFileSync(CONFIG, "utf8");
  const start = src.indexOf("const DRIVER_EXEMPT_TESTS = [");
  if (start === -1) throw new Error("DRIVER_EXEMPT_TESTS not found in eslint.config.mjs");
  const body = src.slice(start, start + src.slice(start).indexOf("\n];"));
  return [...body.matchAll(/"([^"]+\.i?test\.ts)"/g)].map((m) => m[1]!);
}

/** Declared is not enough — a block has to spread it as `files`, or the exemption
 * applies to nobody and this whole describe passes over a rule with no effect. */
function lintConfigUsesDriverList(): boolean {
  const src = readFileSync(CONFIG, "utf8");
  return /files:\s*DRIVER_EXEMPT_TESTS/.test(src);
}

/** Does this source actually reach for something the rule restricts? */
function needsTheExemption(source: string): boolean {
  const { names, groups } = restrictedByTheRule();
  const quoted = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    names.some((n) => new RegExp(`from\\s+"${quoted(n)}"`).test(source)) ||
    groups.some((g) =>
      new RegExp(`from\\s+"${quoted(g).replace(/\\\*/g, '[^"]*')}"`).test(source),
    )
  );
}

const repoFile = (rel: string) => new URL(`../../../${rel}`, import.meta.url);

describe("the driver exemption list", () => {
  it("names only files that exist", () => {
    // An entry for a deleted file is the cheapest way for the list to drift, and it is
    // invisible to the linter: a `files:` glob that matches nothing simply matches
    // nothing.
    for (const path of driverExemptInLintConfig()) {
      expect(existsSync(repoFile(path)), `${path} is exempted but does not exist`).toBe(
        true,
      );
    }
  });

  it("names only files that still import something the rule restricts", () => {
    // THE DIRECTION THE LINTER CANNOT CHECK. Every entry has to still need its
    // exemption; a file that stopped importing the driver keeps a standing pass over a
    // rule that has been told to look away, and the next edit reintroducing raw access
    // to it goes through unremarked.
    for (const path of driverExemptInLintConfig()) {
      const source = readFileSync(repoFile(path), "utf8");
      expect(
        needsTheExemption(source),
        `${path} is in DRIVER_EXEMPT_TESTS but imports none of ` +
          `${restrictedByTheRule().names.join(", ")} — remove the entry or the import`,
      ).toBe(true);
    }
  });

  it("is reading a real list, a real rule, and a wired-in one", () => {
    // Every assertion above passes vacuously over an empty list, and the one about
    // imports also passes vacuously if the rule parsed to no restricted modules — it
    // would then be asking whether each file imports nothing in particular.
    expect(driverExemptInLintConfig().length).toBeGreaterThan(0);
    expect(restrictedByTheRule().names.length).toBeGreaterThan(0);
    expect(lintConfigUsesDriverList()).toBe(true);

    // AND THE DETECTOR ITSELF GETS A CONTROL, BOTH WAYS. Writing this test the first
    // time, the check looked only for `pg` and `drizzle-orm` and reported seven of
    // sixteen entries as stale — because the rule restricts `ioredis` too and seven
    // gateway suites import exactly that. A pattern that fails its own example is
    // broken, not evidence.
    expect(
      needsTheExemption(readFileSync(repoFile("services/api/src/db/repository.itest.ts"), "utf8")),
      "positive control: the repository's own suite must read as needing the exemption",
    ).toBe(true);
    expect(
      needsTheExemption(readFileSync(new URL("./lists-agree.test.ts", import.meta.url), "utf8")),
      "negative control: this file imports nothing restricted and must read as not needing it",
    ).toBe(false);
  });
});
