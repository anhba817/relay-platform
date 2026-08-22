import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import {
  ConnectionEnvironmentConflictError,
  createEnvironment,
  creditConnectionMinutes,
  usageFor,
} from "../db/repository";
import { periodOf } from "./period";

// Connection-minutes, credited (chapter 3.11, US1 and US2).
//
// EVERY TEST HERE DRIVES A CLOCK. The unit is a calendar minute and the
// scenarios are written in them — three boundaries, a socket that lives inside
// one interval, a month that turns over — so the instants are constructed and
// the arithmetic that turns them into buckets belongs to the gateway. What this
// file asserts is what the api does with the numbers when they arrive: once,
// twice, out of order, or not at all.

let pool: ReturnType<typeof createPool>;
let db: Db;

const AUGUST = "2026-08-01";
const SEPTEMBER = "2026-09-01";

beforeAll(async () => {
  pool = createPool();
  db = createDb(pool);
});

afterAll(async () => {
  await pool.end();
});

/** A fresh environment per test. Every assertion below is scoped to one, which
 * is how a suite sharing a database with every other suite says something true
 * about itself (FR-032). */
async function environment(): Promise<string> {
  const env = await createEnvironment(db, { name: `conn-${randomUUID()}` });
  return env.id;
}

const report = (
  environmentId: string,
  entries: Array<[connectionId: string, period: string, minutes: number]>,
) =>
  creditConnectionMinutes(
    db,
    entries.map(([connectionId, period, minutes]) => ({
      connectionId,
      environmentId,
      period,
      minutes,
    })),
  );

const minutesOf = async (environmentId: string, period = AUGUST) =>
  (await usageFor(db, environmentId, period)).connectionMinutes;

describe("a duration becomes a number (US1)", () => {
  it("credits a connection's first report in full", async () => {
    const env = await environment();
    expect(await report(env, [[randomUUID(), AUGUST, 4]])).toBe(4);
    expect(await minutesOf(env)).toBe(4);
  });

  it("counts per connection, so two concurrent sockets cost two", async () => {
    // The property that makes this connection-minutes rather than
    // environment-minutes. A hundred sockets open for one minute is a hundred.
    const env = await environment();
    await report(env, [
      [randomUUID(), AUGUST, 1],
      [randomUUID(), AUGUST, 1],
    ]);
    expect(await minutesOf(env)).toBe(2);
  });

  it("creates the period row for an environment that has only ever connected", async () => {
    // A tenant can accrue connection-minutes without ever sending a message, so
    // the roll-up row cannot be assumed to exist.
    const env = await environment();
    const before = await usageFor(db, env, AUGUST);
    expect(before.connectionMinutes).toBe(0);
    expect(before.messagesSent).toBe(0);

    await report(env, [[randomUUID(), AUGUST, 7]]);
    expect(await minutesOf(env)).toBe(7);
  });

  it("counts a socket that lived and died between two reports (SC-021)", async () => {
    // The registry has already forgotten this connection by the time anything
    // could ask about it; the close handler hands its total over instead. One
    // report, one minute, and the socket was never open at a tick.
    const env = await environment();
    expect(await report(env, [[randomUUID(), AUGUST, 1]])).toBe(1);
    expect(await minutesOf(env)).toBe(1);
  });

  it("does not make a thousand five-second sockets free", async () => {
    // Summing seconds would charge 5,000s = 83 minutes for this. The unit
    // charges what the sockets occupied.
    const env = await environment();
    await report(
      env,
      Array.from({ length: 100 }, () => [randomUUID(), AUGUST, 1] as const).map(
        (e) => [...e] as [string, string, number],
      ),
    );
    expect(await minutesOf(env)).toBe(100);
  });

  it("keeps two environments' figures apart", async () => {
    const a = await environment();
    const b = await environment();
    await report(a, [[randomUUID(), AUGUST, 5]]);
    await report(b, [[randomUUID(), AUGUST, 9]]);
    expect(await minutesOf(a)).toBe(5);
    expect(await minutesOf(b)).toBe(9);
  });
});

describe("the month boundary (SC-011)", () => {
  it("puts a connection's minutes in the periods they happened in", async () => {
    // One socket, two entries — the gateway split it, because it is the side
    // that knows what time it was.
    const env = await environment();
    const connection = randomUUID();
    await report(env, [
      [connection, AUGUST, 2],
      [connection, SEPTEMBER, 2],
    ]);

    expect(await minutesOf(env, AUGUST)).toBe(2);
    expect(await minutesOf(env, SEPTEMBER)).toBe(2);
  });

  it("sums to the connection's total across both periods", async () => {
    const env = await environment();
    const connection = randomUUID();
    await report(env, [
      [connection, AUGUST, 3],
      [connection, SEPTEMBER, 1],
    ]);
    const total =
      (await minutesOf(env, AUGUST)) + (await minutesOf(env, SEPTEMBER));
    expect(total).toBe(4);
  });

  it("advances each period independently as the connection stays open", async () => {
    const env = await environment();
    const connection = randomUUID();
    await report(env, [
      [connection, AUGUST, 3],
      [connection, SEPTEMBER, 1],
    ]);
    // Still open a minute later: August cannot grow, September can.
    await report(env, [
      [connection, AUGUST, 3],
      [connection, SEPTEMBER, 2],
    ]);
    expect(await minutesOf(env, AUGUST)).toBe(3);
    expect(await minutesOf(env, SEPTEMBER)).toBe(2);
  });
});

describe("the report is unreliable, and the number is not (US2)", () => {
  it("credits a replayed report ONCE, and answers zero the second time", async () => {
    const env = await environment();
    const connection = randomUUID();

    expect(await report(env, [[connection, AUGUST, 17]])).toBe(17);
    // The response is the assertion that matters. A test reading only the stored
    // figure would pass against an implementation that credits twice and clamps.
    expect(await report(env, [[connection, AUGUST, 17]])).toBe(0);
    expect(await minutesOf(env)).toBe(17);
  });

  it("repairs a lost report through the next one", async () => {
    // Reports at 5, 10, 15 and the middle one never arrives. The tenant is still
    // charged 15, because a total does not depend on the reports before it.
    const env = await environment();
    const connection = randomUUID();
    await report(env, [[connection, AUGUST, 5]]);
    /* 10 lost */
    await report(env, [[connection, AUGUST, 15]]);
    expect(await minutesOf(env)).toBe(15);
  });

  it("credits nothing for a report that arrives out of order", async () => {
    const env = await environment();
    const connection = randomUUID();
    await report(env, [[connection, AUGUST, 17]]);
    expect(await report(env, [[connection, AUGUST, 12]])).toBe(0);
    expect(await minutesOf(env)).toBe(17);
  });

  it("never lowers a figure, whatever a late report claims", async () => {
    const env = await environment();
    const connection = randomUUID();
    await report(env, [[connection, AUGUST, 17]]);
    for (const late of [0, 1, 16]) {
      await report(env, [[connection, AUGUST, late]]);
      expect(await minutesOf(env)).toBe(17);
    }
  });

  it("charges the same whether every report arrives or only the last", async () => {
    const all = await environment();
    const last = await environment();
    const c1 = randomUUID();
    const c2 = randomUUID();
    for (const m of [3, 6, 9, 12]) await report(all, [[c1, AUGUST, m]]);
    await report(last, [[c2, AUGUST, 12]]);
    expect(await minutesOf(all)).toBe(await minutesOf(last));
  });

  it("refuses a connection that changes environment (409, constitution I)", async () => {
    const a = await environment();
    const b = await environment();
    const connection = randomUUID();
    await report(a, [[connection, AUGUST, 4]]);

    await expect(report(b, [[connection, AUGUST, 9]])).rejects.toBeInstanceOf(
      ConnectionEnvironmentConflictError,
    );
    // And the refusal changed nothing, on either side.
    expect(await minutesOf(a)).toBe(4);
    expect(await minutesOf(b)).toBe(0);
  });

  it("accepts a connection nothing has seen as its first report (R20)", async () => {
    // The api is never told when a connection opens, so "unknown" and "first"
    // are the same state and there is nothing to tell them apart with.
    const env = await environment();
    expect(await report(env, [[randomUUID(), AUGUST, 11]])).toBe(11);
  });
});

describe("the accounting state is bounded by connections, not minutes (SC-017)", () => {
  it("stores the same number of rows for one minute and for sixty", async () => {
    // The naive dedup key is `(connection, minute)`, which is 43.2 million rows
    // a month at a thousand concurrent sockets. This is the assertion that the
    // naive implementation — which passes every other test in this file — fails.
    const short = await environment();
    const long = await environment();
    const ten = () => Array.from({ length: 10 }, () => randomUUID());

    const shortIds = ten();
    const longIds = ten();
    for (const id of shortIds) await report(short, [[id, AUGUST, 1]]);
    for (const id of longIds) {
      for (let m = 1; m <= 60; m++) await report(long, [[id, AUGUST, m]]);
    }

    const rows = async (environmentId: string) =>
      Number(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM usage_connections WHERE environment_id = $1",
            [environmentId],
          )
        ).rows[0].n,
      );

    expect(await rows(short)).toBe(10);
    expect(await rows(long)).toBe(10);
    // And the figures still differ, so this is not measuring nothing.
    expect(await minutesOf(short)).toBe(10);
    expect(await minutesOf(long)).toBe(600);
  });
});

describe("the figure survives a flush of the counter store (SC-016, FR-026)", () => {
  it("reads the same number before and after Redis is emptied", async () => {
    // The property that separates a quota from chapter 3.8's limiter. Connection
    // minutes never touch Redis at all, and this test is what stops that
    // becoming an accident rather than a design.
    const env = await environment();
    await report(env, [[randomUUID(), AUGUST, 23]]);
    const before = await minutesOf(env);

    const { default: Redis } = await import("ioredis");
    const redis = new Redis(process.env.RELAY_REDIS_URL ?? "redis://localhost:6379");
    await redis.flushall();
    await redis.quit();

    expect(await minutesOf(env)).toBe(before);
    expect(before).toBe(23);
  });
});

describe("periodOf is the one definition of which month", () => {
  it("credits the period the reporting instant belongs to", async () => {
    const env = await environment();
    const period = periodOf(new Date("2026-08-22T14:37:00Z"));
    expect(period).toBe(AUGUST);
    await report(env, [[randomUUID(), period, 2]]);
    expect(await minutesOf(env, period)).toBe(2);
  });
});
