import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXEMPT_FILES, isExempt } from "./exempt.js";

// THE DIRECTION THE RULE ITSELF CANNOT CHECK.
//
// The eslint rule and `setup.ts` both answer one question: is this file allowed to
// do a global operation? An unlisted file that tries fails loudly — that is the
// whole job, and it is well covered. What neither can see is a list entry that has
// gone stale, because a name that matches no file matches no violation either. The
// list can only grow, and a stale entry sits there holding a standing exemption
// over a path that some later chapter may create for an unrelated reason.
//
// So this suite checks the list against the TREE, which is the only other party
// that knows the truth. There is no second list to compare against and asking for
// one would just move the problem.

const PLATFORM = join(import.meta.dirname, "..", "..", "..");

describe("the exempt list is checked in both directions", () => {
  it("names a file that exists, for every entry", () => {
    // Delete an exempt suite and this goes red in the same commit. Without it the
    // entry survives the file by however long nobody looks.
    for (const { path } of EXEMPT_FILES) {
      expect(existsSync(join(PLATFORM, path)), `${path} is exempt and absent`)
        .toBe(true);
    }
  });

  it("gives every entry a non-empty reason", () => {
    // The reason is the part a reader uses to decide whether the entry still
    // applies. An empty one makes the list a set of paths, which is the pattern
    // this list exists instead of.
    for (const { path, because } of EXEMPT_FILES) {
      expect(because.trim(), `${path} has no reason`).not.toBe("");
    }
  });

  it("matches on a path suffix and not on a substring", () => {
    // `endsWith` is the matcher, so a file whose name merely CONTAINS an exempt
    // path must not be exempt. Written as a pair, because a single assertion here
    // passes under a matcher that always returns false.
    const real = EXEMPT_FILES[0]!.path;
    expect(isExempt(join("/anywhere", real))).toBe(true);
    expect(isExempt(`${real}.bak`)).toBe(false);
  });

  it("keeps every RELAY_FLAGS name a switch some module reads", () => {
    // A name in that array with no reader would make every non-exempt suite throw
    // until it switched off a relay nobody has written, and the fix a reader
    // reaches for is to set the variable — which teaches that these names are
    // incantations. Read out of `setup.ts` rather than restated, so the two
    // cannot drift.
    const setup = readFileSync(join(import.meta.dirname, "setup.ts"), "utf8");
    const block = /const RELAY_FLAGS = \[([^\]]*)\]/.exec(setup);
    expect(block, "RELAY_FLAGS is not declared the way this test reads it")
      .not.toBeNull();
    const names = [...block![1]!.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
    expect(names.length, "no flags parsed out of RELAY_FLAGS").toBeGreaterThan(0);

    for (const name of names) {
      // A module, not a test: a suite that merely SETS the variable for a child
      // proves nothing about whether anything acts on it.
      const modules = readFileSync(
        join(PLATFORM, "services", "api", "src", "app.module.ts"),
        "utf8",
      );
      const read = [
        modules,
        ...["outbox/outbox.module.ts", "consumer/consumer.module.ts"].map((f) => {
          const abs = join(PLATFORM, "services", "api", "src", f);
          return existsSync(abs) ? readFileSync(abs, "utf8") : "";
        }),
      ].some((text) => text.includes(name));
      expect(read, `${name} is in RELAY_FLAGS and no module reads it`).toBe(true);
    }
  });
});
