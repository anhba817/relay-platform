import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { mintUserToken } from "../auth/user-token";

// What the cap costs at the door (NFR-PERF-01).
//
// COMMITTED RATHER THAN AD-HOC, because the quota chapter's T033 measured with a
// script that lived nowhere, reported regressions of 273% to 411%, and sent two
// code changes chasing a warm-up artefact before instrumentation showed the real
// figure was 0.56 ms. A number nobody can re-run is a number nobody can check.
//
// The BEFORE is in `specs/032-chapter-3-11/baseline.txt`, measured on this
// machine before a line of this chapter existed:
//
//   concurrency 1    mean 6.807 ms   p95 12.537   147 req/s
//   concurrency 8    mean 5.490 ms   p95  9.558  1423 req/s
//   concurrency 32   mean 15.001 ms  p95 35.939  2026 req/s
//
// and the database was 0.053 ms of the 6.807 — three index scans. The room is
// there; what this file checks is that the added read stays in it.

describe("the connect path, with a cap to check", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let pool: ReturnType<typeof createPool>;
  let token: string;
  let environmentId: string;

  beforeAll(async () => {
    pool = createPool();
    db = createDb(pool);
    const env = await createEnvironment(db, { name: `perf-${randomUUID().slice(0, 8)}` });
    environmentId = env.id;
    const repo = new Repository(db, environmentId);
    const user = await repo.createUser("tuan", "Tuan");
    for (let i = 0; i < 5; i++) {
      const channel = await repo.createChannel(`c${i}`, "public");
      await repo.addMember(channel.id, user.id);
    }
    await createApiKey(db, { environmentId });
    const secret = (await environmentSigningSecret(db, environmentId))!.signingSecret;
    token = (
      await mintUserToken(secret, { user: "tuan", environmentId, ttlSeconds: 3600 })
    ).token;

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const session = () =>
    fetch(`${url}/internal/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

  it("reads the cap with index lookups, not a scan", async () => {
    await pool.query("UPDATE environments SET quota_config = $1 WHERE id = $2", [
      JSON.stringify({ connection_minutes: { hard: 100_000 } }),
      environmentId,
    ]);

    // `enable_seqscan = off` FOR THE DURATION OF THE EXPLAIN, AND IT IS THE WHOLE
    // REPAIR. The question this test means to ask is *"can the planner look this up
    // through an index"* — a property of the QUERY. What it asked instead was *"does
    // the planner choose one"*, which is a property of the CORPUS, and on a fresh
    // database the honest answer is no.
    //
    // MEASURED on a two-row database: `Seq Scan on environments e (cost=0.00..1.59)`
    // and `Seq Scan on usage_periods u (cost=0.00..2.69)`. **Postgres is right** —
    // reading one page beats descending a B-tree — so the old assertion required the
    // planner to make a bad choice and failed on every database except a developer's
    // own. It is why CI carried `expected 'Nested Loop Left Join …' to match
    // /Index (Only )?Scan|Index Cond/` on every run.
    //
    // Scoped with `SET LOCAL` inside a transaction, so the setting dies with it and
    // no other suite in this lane inherits a planner that refuses sequential scans.
    const plan = await (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        const res = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS)
           SELECT e.quota_config, u.connection_minutes
             FROM environments e
             LEFT JOIN usage_periods u
               ON u.environment_id = e.id AND u.period = $2
            WHERE e.id = $1`,
          [environmentId, "2026-08-01"],
        );
        await client.query("ROLLBACK");
        return res.rows
          .map((r: Record<string, string>) => r["QUERY PLAN"])
          .join("\n");
      } finally {
        client.release();
      }
    })();

    // `Index Cond`, NOT `Index Scan`, AND THE DIFFERENCE IS 4.12's FINDING.
    //
    // With sequential scans penalised the planner will reach for an index whether or
    // not it can use one, and a predicate it cannot push down comes back as an index
    // scan with a **`Filter:`** — 4.12's *"index present and idle"*, which read
    // `Rows Removed by Join Filter: 1017` with the index sitting there. Measured
    // against a deliberately broken shape, `WHERE e.id::text = $1`:
    //
    //     the shape that ships     Index Cond x2   Filter x0
    //     e.id::text = $1          Index Cond x1   Filter x2
    //
    // An `Index Scan` assertion passes on both. **`Index Cond` per table is the
    // question**: it says the predicate reached the index rather than the rows.
    expect(plan).toMatch(/Index Cond: \(id = /);
    expect(plan).toMatch(/Index Cond: \(\(environment_id = /);
    // And nothing was left to be filtered after the index had its turn — the two
    // lookups above are the only predicates this query has.
    expect(plan).not.toMatch(/Filter:/);
  });

  it("still answers, under load, with the cap configured", async () => {
    // Not a threshold — a smoke test with the numbers printed, so a regression
    // is visible in the log next to the baseline rather than inferred later.
    for (let i = 0; i < 50; i++) await session();

    const latencies: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t = process.hrtime.bigint();
      const res = await session();
      latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
      expect(res.status).toBe(200);
    }
    latencies.sort((a, b) => a - b);
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    // eslint-disable-next-line no-console
    console.log(
      `connect with cap: mean ${mean.toFixed(3)}ms  p50 ${latencies[50]!.toFixed(3)}  p95 ${latencies[95]!.toFixed(3)}`,
    );
    expect(mean).toBeLessThan(200);
  }, 60_000);
});
