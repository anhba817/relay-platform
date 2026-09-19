import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import { createEnvironment } from "../db/repository";
import { quotaConfigSchema } from "./config";

// The CHECK constraint, against a live database (T010a).
//
// `config.test.ts` beside this file tests the PARSER. This tests the other gate,
// and the two are not the same: the constraint is what stops a bad cap being
// stored at all, and the parser is what stops a stored-but-unreadable one being
// applied. The quota chapter called the parser "the second gate rather than the only
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

  it("still refuses everything the quota chapter's clauses refused", async () => {
    // The rebuild's real risk is not the clause it adds, it is a clause it
    // drops. Both of that chapter's dimensions are re-checked here for that reason.
    await expect(set({ messages: { hard: -1 } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
    await expect(set({ active_users: { soft: "lots" } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
    await expect(set([])).rejects.toThrow(/environments_quota_config_shape/);
  });
});

// ── the fourth dimension (chapter 4.10, 0016 rebuilt it again) ─────────────────
//
// 0016 DROPS AND RESTATES TWELVE CLAUSES WHERE 0014 RESTATED NINE, so every earlier
// dimension is re-checked below for the reason the block above gives: the risk in a
// rebuild is the clause it drops, and a dropped clause is invisible from TypeScript.
describe("environments_quota_config_shape, after 0016 rebuilt it", () => {
  it("accepts a storage_bytes cap", async () => {
    await expect(
      set({ storage_bytes: { hard: 1_073_741_824, soft: 858_993_459 } }),
    ).resolves.toBeTruthy();
  });

  it("accepts zero and an explicit null, which are three different states with absent", async () => {
    await expect(set({ storage_bytes: { hard: 0 } })).resolves.toBeTruthy();
    await expect(set({ storage_bytes: { hard: null } })).resolves.toBeTruthy();
    await expect(set({})).resolves.toBeTruthy();
  });

  it("refuses a negative, a fraction and a non-object", async () => {
    await expect(set({ storage_bytes: { hard: -1 } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
    // Bytes are counted, so half of one is a caller who has confused a unit.
    await expect(set({ storage_bytes: { hard: 1.5 } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
    await expect(set({ storage_bytes: 1_073_741_824 })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
    await expect(set({ storage_bytes: { soft: "1GB" } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
  });

  it("still refuses what 0013 and 0014 refused", async () => {
    await expect(set({ messages: { hard: -1 } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
    await expect(set({ active_users: { soft: "lots" } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
    await expect(set({ connection_minutes: { hard: 1.5 } })).rejects.toThrow(
      /environments_quota_config_shape/,
    );
    await expect(set([])).rejects.toThrow(/environments_quota_config_shape/);
  });

  // ── T032: BOTH HALVES, BECAUSE ONE PASSING PROVES NOTHING ABOUT THE OTHER ──
  //
  // The constraint and the parser are two gates on one column and they are written in
  // two languages. `config.ts`'s own comment says what a disagreement costs: the
  // constraint accepts a config the parser rejects, `capsFor` fails closed, and **the
  // cap silently becomes no cap**. A dimension present in one and absent from the other
  // is exactly that state, so both directions are asked here rather than assumed from
  // the change having been made in both files.
  it("and the parser agrees with it about an unimplemented dimension", async () => {
    // The CHECK enumerates four dimensions and says nothing about a fifth, so the
    // database accepts one...
    await expect(set({ disk_inodes: { hard: 10 } })).resolves.toBeTruthy();
    // ...and `.strict()` is what refuses it, which is the division of labour the quota
    // chapter described: *"the constraint cannot express 'and nothing else', while a
    // parser can"*. Two gates, two jobs, and the fifth dimension needs both.
    expect(quotaConfigSchema.safeParse({ disk_inodes: { hard: 10 } }).success).toBe(false);
    expect(quotaConfigSchema.safeParse({ storage_bytes: { hard: 10 } }).success).toBe(true);

    // And the reverse direction: what the parser accepts, the column stores.
    await expect(set({ storage_bytes: { hard: 10 } })).resolves.toBeTruthy();
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
