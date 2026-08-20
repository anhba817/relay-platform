import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The guard must exist only in test databases (constitution IV, T013b).
//
// It is applied by `global-setup.ts` against whatever DATABASE_URL names. The way
// that promise breaks is somebody moving the SQL into `services/api/migrations/`
// because that is where SQL lives — at which point the api ships a trigger whose
// only purpose is to reject its own legitimate sweeps, in production.

const MIGRATIONS = join(
  import.meta.dirname, "..", "..", "..", "services", "api", "migrations",
);

describe("the guard is not a product migration", () => {
  it("finds the migrations directory it claims to police", () => {
    // A scan of an empty or wrong directory passes vacuously.
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(5);
  });

  it("has no CREATE TRIGGER, and no sentinel table, in any migration", () => {
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      expect(sql, `${file} creates a trigger`).not.toMatch(/CREATE\s+TRIGGER/i);
      expect(sql, `${file} names the sentinel`).not.toMatch(/__sentinel/i);
    }
  });

  it("proves the scan can fire", () => {
    // The two assertions above are about absence, so the patterns are checked
    // against text that must match. Chapter 3.8's 4008 test is the precedent.
    expect("CREATE TRIGGER x ON y").toMatch(/CREATE\s+TRIGGER/i);
    expect("__sentinel_environments").toMatch(/__sentinel/i);
  });
});
