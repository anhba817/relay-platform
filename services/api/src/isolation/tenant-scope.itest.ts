import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool } from "../db/client";
import { classifyTables, SPINE_TABLES, type TableClassification } from "../db/catalogue";

import type { Db } from "../db/client";

// THE STRUCTURAL HALF (FR-012, SC-007, constitution I).
//
// `gauntlet.itest.ts` attacks the endpoints that exist. This asks about the leak
// that has no endpoint yet: a table with no path back to an environment is
// exposed by the first query that joins it, and nothing before that moment fails.
//
// The classification is derived in `db/catalogue.ts` — see its comments for the
// spine's reasons, and for the outbox retention finding that came out of writing
// them.
//
// WHAT THIS DOES NOT CHECK, and the distinction is easy to lose: that every table
// HAS a tenant path, not that every QUERY respects the one it has. The gauntlet
// makes the second claim, endpoint by endpoint. Neither implies the other.

describe("every table has a path to one tenant", () => {
  // `ReturnType` rather than `import type pg from "pg"`: the driver's own types
  // are behind the same ban as the driver (FR-043), and a type-only import is
  // still an import to `no-restricted-imports`.
  let pool: ReturnType<typeof createPool>;
  let db: Db;
  let tables: TableClassification[];

  beforeAll(async () => {
    pool = createPool();
    db = createDb(pool);
    tables = await classifyTables(db);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("classifies every base table as direct, hop or spine", () => {
    const unclassified = tables.filter((t) => t.path === null).map((t) => t.table);
    // The message names the tables, because the useful half of this failure is
    // WHICH table appeared — a new migration's, almost always.
    expect(
      unclassified,
      `these tables have no path to an environment: ${unclassified.join(", ")}. ` +
        `Add environment_id, add a foreign key to a table that has one, or add it ` +
        `to SPINE in db/catalogue.ts with a reason.`,
    ).toEqual([]);
  });

  it("classifies each table exactly once", () => {
    const seen = new Set<string>();
    for (const t of tables) {
      expect(seen.has(t.table), `${t.table} classified twice`).toBe(false);
      seen.add(t.table);
    }
    expect(seen.size).toBe(tables.length);
  });

  // COUNTS ARE RECORDED, NOT ASSERTED (T038). `__sentinel_environments` is
  // created by the test harness, so it exists on a database the lane has run
  // against and not on a fresh one — "12 direct" is 11 or 12 depending on how
  // this database was built, and an assertion on the number would fail for a
  // reason that has nothing to do with tenancy. The numbers live in
  // `baseline.txt`; the property lives above.
  it("reports the counts", () => {
    const by = (p: string) => tables.filter((t) => t.path === p);
    const line =
      `tenant paths: ${tables.length} base tables — ` +
      `${by("direct").length} direct, ${by("hop").length} hop, ${by("spine").length} spine`;
    console.log(line);
    for (const t of by("hop")) console.log(`  hop: ${t.table} → ${t.via.join(", ")}`);
    expect(tables.length).toBeGreaterThan(0);
  });

  it("keeps the spine list honest: every entry is a real table with no environment_id", () => {
    const byName = new Map(tables.map((t) => [t.table, t]));
    for (const name of SPINE_TABLES) {
      const found = byName.get(name);
      expect(found, `SPINE names ${name}, which is not a base table in public`).toBeDefined();
      // A spine table that gains `environment_id` classifies as `direct`, and its
      // list entry is then a stale claim rather than a harmless one. This is the
      // assertion that makes the entry rot loudly.
      expect(found?.path, `SPINE names ${name}, but it now has a tenant path of its own`).toBe(
        "spine",
      );
    }
  });

  it("derives hops from foreign keys rather than from names", () => {
    // `members` and `messages` each reach TWO direct tables — `channels` and
    // `users`. The rule is existence, not uniqueness; an earlier draft of
    // data-model.md said "exactly one foreign key", which would have classified
    // neither and failed totality on both.
    const hops = tables.filter((t) => t.path === "hop");
    for (const hop of hops) {
      expect(hop.via.length, `${hop.table} is a hop with no target`).toBeGreaterThan(0);
      for (const target of hop.via) {
        const t = tables.find((x) => x.table === target);
        expect(t?.path, `${hop.table} hops through ${target}, which is not direct`).toBe("direct");
      }
    }
  });
});
