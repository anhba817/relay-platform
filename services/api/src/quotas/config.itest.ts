import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import { createEnvironment } from "../db/repository";

// The CHECK constraint, against a live database (chapter 3.11, T010a).
//
// `config.test.ts` beside this file tests the PARSER. This tests the other gate,
// and the two are not the same: the constraint is what stops a bad cap being
// stored at all, and the parser is what stops a stored-but-unreadable one being
// applied. Chapter 3.10 called the parser "the second gate rather than the only
// one"; this file is the first.
//
// WHY IT EXISTS AT ALL. Migration 0010 DROPS and REBUILDS
// `environments_quota_config_shape`, because Postgres has no `ALTER CONSTRAINT`
// for a CHECK expression. A rebuild that silently lost a clause looks identical
// from TypeScript — every parser test still passes, and the database quietly
// starts accepting rows it used to refuse.

let pool: ReturnType<typeof createPool>;
let db: Db;
let environmentId: string;

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
  const env = await createEnvironment(db, { name: `config-itest-${Date.now()}` });
  environmentId = env.id;
});

afterAll(async () => {
  await pool.end();
});

const set = (config: unknown) =>
  pool.query("UPDATE environments SET quota_config = $1 WHERE id = $2", [
    JSON.stringify(config),
    environmentId,
  ]);

describe("environments_quota_config_shape, after 0010 rebuilt it", () => {
  it("accepts a connection_minutes cap", async () => {
    await expect(
      set({ connection_minutes: { hard: 50_000, soft: 40_000 } }),
    ).resolves.toBeTruthy();
  });

  it("accepts zero, which is not the same as absent", async () => {
    await expect(set({ connection_minutes: { hard: 0 } })).resolves.toBeTruthy();
  });

  it("accepts an explicit null", async () => {
    await expect(
      set({ connection_minutes: { hard: null, soft: 100 } }),
    ).resolves.toBeTruthy();
  });

  it("refuses a negative cap", async () => {
    await expect(set({ connection_minutes: { hard: -1 } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
  });

  it("refuses a non-integer cap", async () => {
    await expect(set({ connection_minutes: { hard: 1.5 } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
  });

  it("refuses a non-object dimension", async () => {
    await expect(set({ connection_minutes: 50_000 })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
  });

  it("still refuses everything chapter 3.10's clauses refused", async () => {
    // The rebuild's real risk is not the clause it adds, it is a clause it
    // drops. Both of 3.10's dimensions are re-checked here for that reason.
    await expect(set({ messages: { hard: -1 } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
    await expect(set({ active_users: { soft: "lots" } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
    await expect(set([])).rejects.toThrow(/environments_quota_config_shape/);
  });
});

describe("quota_notifications_dimension_check, after 0010 rebuilt it", () => {
  const row = (dimension: string) =>
    pool.query(
      `INSERT INTO quota_notifications
         (id, environment_id, organisation_id, period, dimension, threshold, quota, usage_at_crossing)
       SELECT gen_random_uuid(), e.id, a.organisation_id, '2026-08-01', $2, 50, 10, 5
         FROM environments e JOIN applications a ON a.id = e.application_id
        WHERE e.id = $1`,
      [environmentId, dimension],
    );

  it("accepts connection_minutes", async () => {
    await expect(row("connection_minutes")).resolves.toBeTruthy();
  });

  it("still refuses a dimension nobody implemented", async () => {
    await expect(row("media_bytes")).rejects.toThrow(
      /quota_notifications_dimension_check/,
    );
  });
});
