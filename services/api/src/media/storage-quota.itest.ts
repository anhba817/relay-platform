import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { createApiKey, createEnvironment, Repository } from "../db/repository";
import { ensureBucket, storeConfig } from "./store";

// THE STORAGE CAP (FR-MED-02's third refusal, FR-RTL-05 as amended in SRS 1.17).
//
// A LEVEL, NOT A MONTHLY FLOW, AND THAT IS WHY THE CAP IS CONFIGURATION AND THE
// ACCOUNTING IS A SUM. `usage_periods` is keyed on a calendar month and `creditFor`
// never subtracts; stored bytes fall when objects are deleted and do not reset on the
// 1st. A tenant holding 100 GB would start every month at zero.

describe("the storage cap", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let pool: ReturnType<typeof createPool>;
  const store = storeConfig();

  /** A dedicated connection off the lane's own pool, in the two methods this file uses.
   *
   *  `pool.connect()` AND NOT `new pg.Client(...)`: a lint rule refuses a raw `pg`
   *  import outside `services/api/src/db` in constitution I's words, and it is right to
   *  — the first draft of this file imported the driver and was told so. A checked-out
   *  client is a dedicated connection, which is all a hand-written transaction needs.
   *
   *  AND THE TYPE IS WRITTEN OUT RATHER THAN INFERRED, because the rule reaches type
   *  positions too: `import type pg from "pg"` is the same import to `no-restricted-imports`,
   *  and `connect` is overloaded, so `ReturnType` resolves to the callback form's `void`.
   *  Two methods is the whole surface this file touches. */
  interface Client {
    query<R extends object = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: R[] }>;
    release(): void;
  }
  const checkout = async (): Promise<Client> =>
    (await pool.connect()) as unknown as Client;

  /** A fresh tenant per test. The cap is per environment and the accounting is a sum
   *  over that environment's rows, so sharing one between tests would make every
   *  assertion depend on the order they ran in. */
  const tenant = async (
    config: unknown,
  ): Promise<{ id: string; credential: string }> => {
    const env = await createEnvironment(db, { name: `media-quota-${Date.now()}-${Math.random()}` });
    if (config !== undefined) {
      await pool.query("UPDATE environments SET quota_config = $1 WHERE id = $2", [
        JSON.stringify(config),
        env.id,
      ]);
    }
    const key = await createApiKey(db, { environmentId: env.id });
    return { id: env.id, credential: key.credential };
  };

  const ask = async (
    credential: string,
    bytes: number,
  ): Promise<{ status: number; code?: string; message?: string }> => {
    const res = await fetch(`${url}/v1/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ filename: "q.png", mime_type: "image/png", bytes }),
    });
    const body = (await res.json()) as { code?: string; message?: string };
    return { status: res.status, ...body };
  };

  const committed = async (environmentId: string): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT coalesce(sum(declared_bytes), 0)::text AS n FROM media_objects WHERE environment_id = $1",
      [environmentId],
    );
    return Number(rows[0]!.n);
  };

  beforeAll(async () => {
    await ensureBucket(store);
    pool = createPool();
    db = createDb(pool);
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile())
      .createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // T033. AN ABSENT CAP IS NOT A CAP OF ZERO AND NOT A CAP OF INFINITY.
  it("lets an environment with no storage_bytes key upload anything", async () => {
    const t = await tenant({ messages: { hard: 10 } });
    expect((await ask(t.credential, 9_000_000)).status).toBe(201);
    expect((await ask(t.credential, 9_000_000)).status).toBe(201);
    // AND THE OTHER DIMENSION'S CAP IS STILL THERE, which is the control: "absent means
    // no cap" is satisfied by a config nothing reads at all.
    expect(await committed(t.id)).toBe(18_000_000);
  });

  it("refuses when the sum plus the declared size would cross the cap", async () => {
    const t = await tenant({ storage_bytes: { hard: 1_000_000 } });
    expect((await ask(t.credential, 600_000)).status).toBe(201);

    const refused = await ask(t.credential, 600_000);
    expect(refused.code).toBe("media_storage_exhausted");
    expect(refused.status).toBe(402);
    // BOTH FIGURES, because the remedy is to delete and a tenant cannot decide how much
    // to delete from one of them.
    expect(refused.message).toContain("600000");
    expect(refused.message).toContain("1000000");
    // AND WAITING IS NOT THE REMEDY. Three of Relay's quotas promise a resume date and
    // this one must not: a level does not refill on the 1st.
    expect(refused.message).not.toMatch(/resume|first of|month/i);

    // The refusal reserved nothing.
    expect(await committed(t.id)).toBe(600_000);
  });

  // T041. THREE REQUESTS ON THE THREE SIDES OF THE BOUND, AND THE MIDDLE ONE IS THE
  // TEST. A request for half the cap proves the comparison exists; only the one that
  // lands exactly on it says whether `>` or `>=` was written. Chapter 4.7 found both
  // obvious ways to plant a 0.1% drift passing for precisely this reason — the naive
  // shortfall and the naive excess both sit inside the bound, and the smallest breaching
  // drift is one more than either.
  it("issues one byte under the cap, issues the byte that fills it, refuses the next", async () => {
    const under = await tenant({ storage_bytes: { hard: 1_000 } });
    expect((await ask(under.credential, 999)).status).toBe(201);
    expect(await committed(under.id)).toBe(999);

    const exact = await tenant({ storage_bytes: { hard: 1_000 } });
    expect((await ask(exact.credential, 1_000)).status).toBe(201);
    // ONE BYTE OVER A FULL CAP, which is the smallest refusable request there is.
    expect((await ask(exact.credential, 1)).code).toBe("media_storage_exhausted");
    expect(await committed(exact.id)).toBe(1_000);

    // AND ONE BYTE OVER AN EMPTY CAP, so the refusal is about the arithmetic and not
    // about the tenant already holding something.
    const over = await tenant({ storage_bytes: { hard: 1_000 } });
    expect((await ask(over.credential, 1_001)).code).toBe("media_storage_exhausted");
    expect(await committed(over.id)).toBe(0);
  }, 60_000);

  it("treats a cap of zero as a refusal of everything, which absent does not", async () => {
    // ZERO AND ABSENT ARE DIFFERENT STATES and the parser keeps them apart. A cap that
    // collapsed zero into absent would turn the strictest configuration into the
    // loosest one, silently.
    const t = await tenant({ storage_bytes: { hard: 0 } });
    expect((await ask(t.credential, 1)).code).toBe("media_storage_exhausted");
    expect(await committed(t.id)).toBe(0);
  });

  // ── T036: THE RACE, AND TWO CONCURRENT REQUESTS DO NOT PRODUCE IT ─────────────
  //
  // THE FIRST VERSION OF THIS TEST FIRED TEN SLOT REQUESTS AT ONCE AND PASSED WITHOUT
  // THE LOCK. `Promise.all` over ten `fetch` calls admitted exactly one every time, with
  // `FOR UPDATE` and without it: each request's transaction is a sum and an insert a
  // millisecond apart, and the read-then-write windows never happened to overlap. **A
  // race test that cannot lose the race is an assertion that cannot fail** — it would
  // have gone green over the unserialised version this chapter exists to warn about.
  //
  // SO THE INTERLEAVE IS WRITTEN BY HAND, on two Postgres clients, and both transactions
  // READ before either WRITES. That is what "two slot requests race the same remaining
  // allowance" means; an interleave where the second reads after the first commits is a
  // sequence wearing a race's name. Run both ways in one test, because the number that
  // matters is the DIFFERENCE and a lock is only worth its cost if the unlocked version
  // is wrong.
  it("admits two writers without the lock and one with it, interleaved by hand", async () => {
    const attempt = async (useLock: boolean): Promise<{ blocked: boolean; total: number }> => {
      const t = await tenant({ storage_bytes: { hard: 1_000 } });
      const lock = useLock ? " for update" : "";
      const a = await checkout();
      const b = await checkout();
      const sum = async (c: Client): Promise<number> =>
        Number(
          (
            await c.query<{ n: string }>(
              "SELECT coalesce(sum(declared_bytes), 0)::text AS n FROM media_objects WHERE environment_id = $1",
              [t.id],
            )
          ).rows[0]!.n,
        );
      const put = (c: Client, tag: string): Promise<unknown> =>
        c.query(
          `INSERT INTO media_objects (id, environment_id, filename, mime_type, declared_bytes, object_key)
           VALUES ($1, $2, $3, 'image/png', 600, $4)`,
          [randomUUID(), t.id, tag, `${t.id}/${tag}`],
        );

      try {
        await a.query("begin");
        await b.query("begin");
        await a.query(`SELECT quota_config FROM environments WHERE id = $1${lock}`, [t.id]);

        // B asks the same question. Under `for update` it cannot answer until A commits,
        // which is the entire mechanism stated as an observation.
        let answered = false;
        const bRead = b
          .query(`SELECT quota_config FROM environments WHERE id = $1${lock}`, [t.id])
          .then(async () => {
            answered = true;
            return sum(b);
          });
        await new Promise((r) => setTimeout(r, 300));
        const blocked = !answered;

        if ((await sum(a)) + 600 <= 1_000) await put(a, "a");
        await a.query("commit");

        const seen = await bRead;
        if (seen + 600 <= 1_000) await put(b, "b");
        await b.query("commit");
        return { blocked, total: await committed(t.id) };
      } finally {
        a.release();
        b.release();
      }
    };

    const plain = await attempt(false);
    expect(plain.blocked, "the unlocked select blocked, so the probe proves nothing").toBe(false);
    // 1,200 COMMITTED AGAINST A CAP OF 1,000. Both writers read zero and both found room.
    expect(plain.total).toBe(1_200);

    const locked = await attempt(true);
    expect(locked.blocked, "the locked select did not block").toBe(true);
    expect(locked.total).toBe(600);
  }, 60_000);

  // AND THE TEST ABOVE IS ABOUT POSTGRES, NOT ABOUT THIS REPOSITORY. It proves the lock
  // serialises two writers; it says nothing about whether `reserveMediaSlot` takes one.
  // The two halves are separate claims and the second one is the one that rots — a
  // refactor that drops `.for("update")` leaves the first test green.
  //
  // THE OBVIOUS PROBE FOR THE SECOND CLAIM CANNOT TELL THE TWO LOCKS APART, and it was
  // written and run before this one. Hold the environment row with `FOR UPDATE`, call
  // `reserveMediaSlot`, and watch it wait — it waits, **and it waits with the explicit
  // lock deleted**. `media_objects.environment_id` is a foreign key, so the INSERT takes
  // `FOR KEY SHARE` on the parent row all by itself, and `FOR KEY SHARE` conflicts with
  // `FOR UPDATE`. The probe was measuring the foreign key.
  //
  // `FOR NO KEY UPDATE` IS THE DISCRIMINATOR. Postgres's row-lock conflict table puts
  // `FOR UPDATE` in conflict with it and `FOR KEY SHARE` not in conflict with it, so a
  // holder in that mode blocks exactly the lock this method asks for and nothing the
  // foreign key does. Blocked means the `SELECT ... FOR UPDATE` is there; not blocked
  // means the insert's own lock was all that was ever happening.
  it("makes the real reservation path wait for the lock it asks for, not the one the FK takes", async () => {
    const t = await tenant({ storage_bytes: { hard: 1_000 } });
    const repo = new Repository(db, t.id);
    const holder = await checkout();

    try {
      await holder.query("begin");
      await holder.query(
        "SELECT quota_config FROM environments WHERE id = $1 FOR NO KEY UPDATE",
        [t.id],
      );

      let settled = false;
      const reservation = repo
        .reserveMediaSlot({
          id: randomUUID(),
          userId: null,
          filename: "held.png",
          mimeType: "image/png",
          declaredBytes: 600,
          objectKey: `${t.id}/held`,
        })
        .then((r) => {
          settled = true;
          return r;
        });

      await new Promise((r) => setTimeout(r, 300));
      expect(settled, "the reservation did not wait for the lock").toBe(false);
      // NOTHING WAS WRITTEN WHILE IT WAITED, which is the other half: a method that
      // inserted first and locked afterwards would also look blocked from here.
      expect(await committed(t.id)).toBe(0);

      await holder.query("commit");
      expect((await reservation).reserved).toBe(true);
      expect(await committed(t.id)).toBe(600);
    } finally {
      holder.release();
    }
  }, 60_000);
});
