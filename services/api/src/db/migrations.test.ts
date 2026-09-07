import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// THE GENERATOR IS RETIRED, AND A DECISION RECORDED ONLY IN A COMMENT IS A DECISION
// THE NEXT CONTRIBUTOR REVERSES BY ACCIDENT (feature 043, FR-023a).
//
// Migrations here are hand-written and reviewed against SAD §6.1. That is not this
// feature's preference — ADR-16 has said it since chapter 3.9: *"migrations remain
// versioned, forward-only, hand-reviewed SQL"*. A generator's output is none of those
// things, so the tooling had contradicted the constitution the whole time rather than
// the other way round.
//
// WHAT THE DRIFT LOOKED LIKE. `migrations/meta/` held drizzle-kit's snapshots, one per
// generated migration, and they stopped keeping up: **15 SQL files against 8 snapshots,
// seven behind**, measured when they were deleted. The revisions chapter recorded them as six
// behind and the attachments chapter as seven. A generator whose snapshot is seven migrations stale
// cannot produce a correct diff, so the next person to run it would have been handed a
// migration that re-created tables that already exist.
//
// `drizzle.config.ts` WENT TOO, AND THAT IS A DEVIATION WORTH NAMING. The task said to
// state the decision in that file. A config file for a retired tool is the thing that
// invites the tool back — and it imports `drizzle-kit`, so keeping it would have meant
// keeping the dependency that makes generating possible. The statement moved to
// `migrate.ts`, which is the file somebody actually opens to learn how migrations work,
// and this test is what holds it.
//
// `drizzle-orm` STAYS. It is the query builder the repository layer is built on
// (ADR-16) and has nothing to do with generation. Only `drizzle-kit` is gone.

// `__dirname`, not `import.meta` — this service builds to CommonJS, and `migrate.ts`
// beside it resolves the same directory the same way.
const API_ROOT = join(__dirname, "..", "..");
const MIGRATIONS = join(API_ROOT, "migrations");

describe("the migration directory", () => {
  it("has no generator config, snapshots, or drizzle-kit dependency", () => {
    // Each of the three is a separate way for generation to come back, so each is
    // named. A single "the generator is gone" assertion would pass while two thirds of
    // it returned.
    expect(existsSync(join(MIGRATIONS, "meta"))).toBe(false);
    expect(existsSync(join(API_ROOT, "drizzle.config.ts"))).toBe(false);

    const pkg = JSON.parse(
      readFileSync(join(API_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain(
      "drizzle-kit",
    );
  });

  it("holds only forward-only .sql files, in an unbroken numbered sequence", () => {
    // The runner (`migrate.ts`) applies `.sql` in filename order and records each in
    // `schema_migrations`. Two things break that silently: a file the runner ignores
    // sitting in the directory looking like a migration, and a gap in the numbering that
    // makes a reviewer think a migration is missing when it never existed.
    const entries = readdirSync(MIGRATIONS, { withFileTypes: true });

    const strays = entries
      .filter((e) => !e.isFile() || !e.name.endsWith(".sql"))
      .map((e) => e.name);
    expect(strays).toEqual([]);

    const numbers = entries
      .map((e) => /^(\d{4})_/.exec(e.name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    expect(numbers.length).toBe(entries.length);
    expect(numbers).toEqual(numbers.map((_, i) => i));

    // NO DOWN PATH, EVER. Forward-only is the constitution's word, and a `_down.sql`
    // beside a migration is how that erodes without anybody deciding to erode it.
    expect(entries.filter((e) => /down/i.test(e.name))).toEqual([]);
  });
});
