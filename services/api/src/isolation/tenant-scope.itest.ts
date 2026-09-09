import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyTables, SPINE_TABLES, type TableClassification } from "../db/catalogue";
import { createDb, createPool } from "../db/client";

import type { Db } from "../db/client";

// THE STRUCTURAL HALF (FR-012, constitution I).
//
// The gauntlet attacks the endpoints that exist. This asks about THE LEAK THAT HAS NO
// ENDPOINT YET: a table with no path back to an environment is exposed by the first
// query that joins it, and nothing before that moment fails.
//
// WHAT THIS DOES NOT CHECK, and the distinction is easy to lose: that every table HAS a
// tenant path, not that every QUERY respects the one it has. The gauntlet makes the
// second claim, endpoint by endpoint. Neither implies the other.

describe("every table has a path to one tenant", () => {
  // `ReturnType` rather than `import type pg from "pg"`: the driver's own types are
  // behind the same ban as the driver, and a type-only import is still an import to
  // `no-restricted-imports`.
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
    // The message names the tables, because the useful half of this failure is WHICH
    // table appeared — a new migration's, almost always.
    expect(
      unclassified,
      `these tables have no path to an environment: ${unclassified.join(", ")}. ` +
        `Add environment_id, add a foreign key to a table that has one, or add it to ` +
        `SPINE in db/catalogue.ts with a reason.`,
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

  it("has no spine entry for a table that does not exist", () => {
    // THE DIRECTION THAT CATCHES A DROPPED TABLE. A spine entry outliving its table is
    // an exemption standing over nothing — harmless today, and waiting to cover a
    // future table that happens to reuse the name.
    const present = new Set(tables.map((t) => t.table));
    const stale = SPINE_TABLES.filter((t) => !present.has(t));
    expect(stale, `spine names tables that do not exist: ${stale.join(", ")}`).toEqual([]);
  });

  it("gives every spine table a reason", () => {
    const reasonless = tables
      .filter((t) => t.path === "spine" && (t.reason ?? "").trim() === "")
      .map((t) => t.table);
    expect(reasonless).toEqual([]);
  });

  it("reports the shape of the schema", () => {
    const by = (p: TableClassification["path"]) => tables.filter((t) => t.path === p);
    const direct = by("direct");
    const hop = by("hop");
    const spine = by("spine");
    console.log(
      `tenant paths: ${tables.length} tables — ${direct.length} direct, ` +
        `${hop.length} hop, ${spine.length} spine`,
    );
    expect(direct.length + hop.length + spine.length).toBe(tables.length);
    // A hop with no target is a hop in name only, and the query that produced it
    // would have to be wrong for this to happen — which is why it is asserted.
    for (const t of hop) {
      expect(t.via.length, `${t.table} is a hop to nowhere`).toBeGreaterThan(0);
    }
  });

  it("reads the direct tables a chain arrives at, not the ones it passes through", () => {
    // THE REACH BECAME TRANSITIVE IN THIS CHAPTER, and this test is the half of it that
    // NOTHING ABOVE CAN SEE. `message_edits` is the first table two links away — it
    // references `messages`, which references `channels`, which carries the column — and
    // the one-hop query classified it as having no tenant at all.
    //
    // Reverting the walk to one hop turns three tests red, this one included, so the
    // transitive half is well covered. THE SECOND EXPECTATION IS THE ONE THAT STANDS
    // ALONE: drop the `IN (SELECT table_name FROM direct)` filter from `fk_targets` and
    // the walk starts reporting the tables it passed THROUGH — six of them here — and
    // every other test in this file stays green, because "a hop has some target" is truer
    // with intermediates in the list, not less true.
    //
    // A `via` naming `messages` would be the catalogue reporting its own intermediate
    // step, and `tenant-scope`'s whole claim is that `via` names tables a repository can
    // scope by. Asserting "every via is itself direct" would not catch it: the SQL filter
    // makes that true by construction whenever the filter is there at all.
    const edits = tables.find((t) => t.table === "message_edits");
    expect(edits?.path).toBe("hop");
    expect(edits?.via).not.toContain("messages");
    expect([...(edits?.via ?? [])].sort()).toEqual(["channels", "users"]);
  });
});
