import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The guard must exist only in test databases (constitution IV, T013b).
//
// It is applied by `global-setup.ts` against whatever DATABASE_URL names. The way
// that promise breaks is somebody moving the SQL into `services/api/migrations/`
// because that is where SQL lives — at which point the api ships a trigger whose
// only purpose is to reject its own legitimate sweeps, in production.
//
// NARROWED BY CHAPTER 4.18, FROM "NO TRIGGER" TO "NOT THIS TRIGGER". The rule used to
// be wider than the reason above, and the audit log is the first thing to need the
// difference. `0021_audit_log.sql` ships a `BEFORE UPDATE OR DELETE` trigger whose
// purpose is the opposite of the guard's: it refuses writes the api must never make,
// rather than writes the api makes constantly. `REVOKE UPDATE, DELETE` is not an
// alternative — the api connects as a superuser and the revoke was measured inert
// (research R2) — and a migration is the only thing that applies schema, so there is
// nowhere else for it to live.
//
// What is still forbidden is the sentinel guard, by name, in both directions: the
// trigger that names it and the table it names.

const MIGRATIONS = join(
  import.meta.dirname, "..", "..", "..", "services", "api", "migrations",
);

/** A trigger is the guard when it names the sentinel. The product's own triggers are
 * caught by nothing here, which is the point of the narrowing — and they are not
 * unpoliced: a trigger with no argument beside it fails code review, and the audit
 * trigger's argument is in the migration that creates it. */
const SENTINEL_TRIGGER = /CREATE\s+TRIGGER[^;]*__sentinel/is;

describe("the guard is not a product migration", () => {
  it("finds the migrations directory it claims to police", () => {
    // A scan of an empty or wrong directory passes vacuously.
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(5);
  });

  it("has no sentinel trigger, and no sentinel table, in any migration", () => {
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      expect(sql, `${file} creates the guard trigger`).not.toMatch(SENTINEL_TRIGGER);
      expect(sql, `${file} names the sentinel`).not.toMatch(/__sentinel/i);
    }
  });

  it("proves the scan can fire", () => {
    // The two assertions above are about absence, so the patterns are checked
    // against text that must match. The rate-limit chapter's 4008 test is the precedent.
    // THE REAL TEXT, copied from `sentinel.sql`, not a plausible imitation of it. A
    // control built from what the pattern was written against proves the pattern matches
    // itself; this one proves it matches the thing it has to catch.
    expect(
      "CREATE TRIGGER __sentinel_guard_%1$s\n" +
        "   BEFORE UPDATE OR DELETE ON %1$I FOR EACH ROW\n" +
        "   WHEN (__is_sentinel(OLD.environment_id))\n" +
        "   EXECUTE FUNCTION __sentinel_guard()",
    ).toMatch(SENTINEL_TRIGGER);
    expect("__sentinel_environments").toMatch(/__sentinel/i);
  });

  it("still permits the trigger the audit log ships", () => {
    // THE NARROWING, ASSERTED RATHER THAN DESCRIBED. Without this, a later edit could
    // widen the pattern back to every trigger and nothing would say the rule had
    // changed — the comment above would be the only record, and a comment is not a test.
    expect(
      "create trigger audit_log_append_only before update or delete on audit_log\n" +
        "  for each row execute function audit_log_refuse_write();",
    ).not.toMatch(SENTINEL_TRIGGER);
  });
});
