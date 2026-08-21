import { randomUUID } from "node:crypto";

import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createDb, createPool, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import { createEnvironment, Repository, usageFor } from "../db/repository";
import { environments } from "../db/schema";
import { QuotaExceededError } from "./quota.error";
import { periodOf } from "./period";

// Chapter 3.10, User Story 1 — the month is counted, and the count survives.
//
// Everything here is about a number. The cap, the refusal and the email are later
// phases and none of them means anything if the number is wrong.

const PERIOD = periodOf(new Date());

describe("the month's usage", () => {
  let pool: ReturnType<typeof createPool>;
  let db: Db;

  beforeAll(async () => {
    pool = createPool();
    await migrate(pool);
    db = createDb(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  /** A fresh environment with a channel, and a repository scoped to it. Fresh per
   * test, because a usage count that borrowed another test's rows would be the
   * fault this whole lane has been recording since chapter 3.3. */
  const seed = async () => {
    const env = await createEnvironment(db, {
      name: `quota-itest-${randomUUID().slice(0, 8)}`,
    });
    const repo = new Repository(db, env.id);
    const channel = await repo.createChannel(
      `c-${randomUUID().slice(0, 8)}`,
      "public",
    );
    return { environmentId: env.id, repo, channelId: channel.id };
  };

  const newUser = async (repo: Repository) =>
    (await repo.createUser(`u-${randomUUID().slice(0, 8)}`)).id;

  it("counts exactly the messages sent and the distinct users who sent them", async () => {
    const { environmentId, repo, channelId } = await seed();
    const alice = await newUser(repo);
    const bob = await newUser(repo);

    // Five messages, two senders. The counts are different numbers on purpose:
    // a roll-up that incremented both together would pass a test where they
    // happened to match.
    for (const userId of [alice, alice, bob, alice, bob]) {
      await repo.sendMessage(channelId, { text: "hi", userId });
    }

    const usage = await usageFor(db, environmentId, PERIOD);
    expect(usage.messagesSent).toBe(5);
    expect(usage.activeUsers).toBe(2);
  }, 30_000);

  it("reports zeros for an environment that has sent nothing", async () => {
    const { environmentId } = await seed();
    const usage = await usageFor(db, environmentId, PERIOD);
    expect(usage.messagesSent).toBe(0);
    expect(usage.activeUsers).toBe(0);
    expect(usage.messageQuota).toBeNull();
    expect(usage.activeUserQuota).toBeNull();
  }, 30_000);

  it("counts per environment, so a sibling of the same application reports zero", async () => {
    const a = await seed();
    const b = await seed();
    await a.repo.sendMessage(a.channelId, {
      text: "hi",
      userId: await newUser(a.repo),
    });

    expect((await usageFor(db, a.environmentId, PERIOD)).messagesSent).toBe(1);
    expect((await usageFor(db, b.environmentId, PERIOD)).messagesSent).toBe(0);
  }, 30_000);

  it("counts an unattributed send toward messages and toward no user", async () => {
    // A key-authenticated REST send carries no user — unattributed by design
    // since chapter 3.3. It is still a message the tenant sent.
    const { environmentId, repo, channelId } = await seed();
    await repo.sendMessage(channelId, { text: "hi" });

    const usage = await usageFor(db, environmentId, PERIOD);
    expect(usage.messagesSent).toBe(1);
    expect(usage.activeUsers).toBe(0);
  }, 30_000);

  it("does not count a recognised idempotent retry twice", async () => {
    // The retry wrote no message, so it must consume no quota. A client
    // retrying on a flaky link is not a second message.
    const { environmentId, repo, channelId } = await seed();
    const userId = await newUser(repo);
    const key = randomUUID();
    await repo.sendMessage(channelId, { text: "hi", userId, idempotencyKey: key });
    await repo.sendMessage(channelId, { text: "hi", userId, idempotencyKey: key });

    expect((await usageFor(db, environmentId, PERIOD)).messagesSent).toBe(1);
  }, 30_000);

  it("keeps a previous month readable after the boundary passes", async () => {
    const { environmentId, repo, channelId } = await seed();
    await repo.sendMessage(channelId, {
      text: "hi",
      userId: await newUser(repo),
    });

    // The period is the key, not a filter, so an older month is a different row
    // rather than a different predicate — and reading it costs nothing.
    const lastMonth = periodOf(new Date("2020-01-15T00:00:00.000Z"));
    expect((await usageFor(db, environmentId, lastMonth)).messagesSent).toBe(0);
    expect((await usageFor(db, environmentId, PERIOD)).messagesSent).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// FR-002, and the reason the roll-up exists at all.
// ---------------------------------------------------------------------------
//
// A rate limit is about this second and forgets; a quota is about this month and
// must not. Chapter 3.8's limiter keeps its counters in Redis, where a flush costs
// one window of over-service. If this chapter had done the same, a flush would
// cost the month — so the number lives where the messages live, and this is the
// test that says so.
describe("the count survives the counter store", () => {
  let pool: ReturnType<typeof createPool>;
  let db: Db;

  beforeAll(async () => {
    pool = createPool();
    await migrate(pool);
    db = createDb(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it("reports identical figures across a FLUSHALL", async () => {
    const env = await createEnvironment(db, {
      name: `quota-flush-${randomUUID().slice(0, 8)}`,
    });
    const repo = new Repository(db, env.id);
    const channel = await repo.createChannel(
      `c-${randomUUID().slice(0, 8)}`,
      "public",
    );
    const userId = (await repo.createUser(`u-${randomUUID().slice(0, 8)}`)).id;
    for (let i = 0; i < 3; i++) {
      await repo.sendMessage(channel.id, { text: `m${i}`, userId });
    }

    const before = await usageFor(db, env.id, PERIOD);
    expect(before.messagesSent).toBe(3);

    // The whole store, not this environment's keys. Chapter 3.8's counters and
    // everything else go with it.
    const redis = new Redis(
      process.env["RELAY_REDIS_URL"] ?? "redis://localhost:6379",
    );
    try {
      await redis.flushall();
    } finally {
      await redis.quit();
    }

    const after = await usageFor(db, env.id, PERIOD);
    expect(after).toEqual(before);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Chapter 3.10, User Story 2 — running out is predictable.
// ---------------------------------------------------------------------------
//
// FR-RTL-08 is unusually specific and the specificity IS the requirement: sends
// refused, history reads and open connections untouched. Refusing everything is
// easy and wrong.
describe("running out", () => {
  let pool: ReturnType<typeof createPool>;
  let db: Db;

  beforeAll(async () => {
    pool = createPool();
    await migrate(pool);
    db = createDb(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  const seed = async () => {
    const env = await createEnvironment(db, {
      name: `quota-cap-${randomUUID().slice(0, 8)}`,
    });
    const repo = new Repository(db, env.id);
    const channel = await repo.createChannel(
      `c-${randomUUID().slice(0, 8)}`,
      "public",
    );
    const userId = (await repo.createUser(`u-${randomUUID().slice(0, 8)}`)).id;
    return { environmentId: env.id, repo, channelId: channel.id, userId };
  };

  const setCaps = async (environmentId: string, config: unknown) => {
    await db
      .update(environments)
      .set({ quotaConfig: config as Record<string, unknown> })
      .where(eq(environments.id, environmentId));
  };

  it("refuses the send and serves the history read, in the same second", async () => {
    // SC-002. One refused request and one successful request against the same
    // environment, in one test, because the requirement is about the pair.
    const { environmentId, repo, channelId, userId } = await seed();
    await repo.sendMessage(channelId, { text: "one", userId });
    await setCaps(environmentId, { messages: { hard: 1 } });

    await expect(
      repo.sendMessage(channelId, { text: "two", userId }),
    ).rejects.toThrow(QuotaExceededError);

    const history = await repo.listMessages(channelId, { limit: 10 });
    expect(history).toHaveLength(1);
    expect(history[0]!.text).toBe("one");
  }, 30_000);

  it("names the dimension, the usage, the quota and the resume date", async () => {
    // T022a — read the WHOLE message rather than asserting on its parts.
    // Chapter 3.8's header bug was found by printing a response and not by any
    // of the eighteen tests asserting on its fields.
    const { environmentId, repo, channelId, userId } = await seed();
    await setCaps(environmentId, { messages: { hard: 0 } });

    const caught = await repo
      .sendMessage(channelId, { text: "x", userId })
      .then(() => null)
      .catch((e: unknown) => e as QuotaExceededError);

    expect(caught).toBeInstanceOf(QuotaExceededError);
    expect(caught!.publicMessage()).toMatch(
      /^monthly message quota exhausted: 0 of 0 for \d{4}-\d{2}-01; sends resume on \d{4}-\d{2}-01$/,
    );
  }, 30_000);

  it("refuses everything at a cap of zero and nothing at no cap", async () => {
    // FR-006. Zero and absent cannot share a representation: an environment can
    // be switched off deliberately.
    const { environmentId, repo, channelId, userId } = await seed();

    await setCaps(environmentId, { messages: { hard: 0 } });
    await expect(
      repo.sendMessage(channelId, { text: "a", userId }),
    ).rejects.toThrow(QuotaExceededError);

    await setCaps(environmentId, {});
    await expect(
      repo.sendMessage(channelId, { text: "b", userId }),
    ).resolves.toBeDefined();
  }, 30_000);

  it("lets a soft threshold refuse nothing", async () => {
    // FR-013. A soft threshold alerts; it is not a cap. At 100% of one, with no
    // hard cap configured, the tenant is still serving traffic.
    const { environmentId, repo, channelId, userId } = await seed();
    await setCaps(environmentId, { messages: { soft: 1 } });

    await repo.sendMessage(channelId, { text: "at the threshold", userId });
    await expect(
      repo.sendMessage(channelId, { text: "past it", userId }),
    ).resolves.toBeDefined();
  }, 30_000);

  it("resumes on the next request when the cap is raised, with no restart", async () => {
    // SC-007, FR-012. Nothing is cached, so there is nothing to clear.
    const { environmentId, repo, channelId, userId } = await seed();
    await setCaps(environmentId, { messages: { hard: 1 } });
    await repo.sendMessage(channelId, { text: "one", userId });
    await expect(
      repo.sendMessage(channelId, { text: "two", userId }),
    ).rejects.toThrow(QuotaExceededError);

    await setCaps(environmentId, { messages: { hard: 2 } });
    await expect(
      repo.sendMessage(channelId, { text: "two", userId }),
    ).resolves.toBeDefined();
  }, 30_000);

  it("takes effect immediately when a cap is lowered below current usage", async () => {
    const { environmentId, repo, channelId, userId } = await seed();
    for (const t of ["a", "b", "c"]) {
      await repo.sendMessage(channelId, { text: t, userId });
    }
    await setCaps(environmentId, { messages: { hard: 2 } });

    await expect(
      repo.sendMessage(channelId, { text: "d", userId }),
    ).rejects.toThrow(QuotaExceededError);
  }, 30_000);

  it("caps distinct users without cutting off the users it already has", async () => {
    // The active-user cap is on how many distinct people may send in a month,
    // not on how much they may say. A sender already counted this period keeps
    // sending; only the next new face is refused. Backwards, this would suspend
    // a tenant the moment their last allowed user sent a second message.
    const { environmentId, repo, channelId, userId } = await seed();
    await setCaps(environmentId, { active_users: { hard: 1 } });
    await repo.sendMessage(channelId, { text: "first", userId });

    await expect(
      repo.sendMessage(channelId, { text: "again", userId }),
    ).resolves.toBeDefined();

    const newcomer = (await repo.createUser(`u-${randomUUID().slice(0, 8)}`)).id;
    await expect(
      repo.sendMessage(channelId, { text: "hello", userId: newcomer }),
    ).rejects.toThrow(QuotaExceededError);
  }, 30_000);

  it("keeps the outbox event for a message accepted before the cap", async () => {
    // FR-011, constitution II. A quota exceeded afterwards does not retroactively
    // un-acknowledge a message, so the event that drives webhook delivery is
    // still there to be drained.
    const { environmentId, repo, channelId, userId } = await seed();
    const sent = await repo.sendMessage(channelId, { text: "accepted", userId });
    await setCaps(environmentId, { messages: { hard: 1 } });
    await expect(
      repo.sendMessage(channelId, { text: "refused", userId }),
    ).rejects.toThrow(QuotaExceededError);

    const { rows } = (await db.execute(
      `SELECT count(*)::int AS n FROM outbox
        WHERE payload->'data'->>'id' = '${sent.id}'`,
    )) as unknown as { rows: { n: number }[] };
    expect(rows[0]!.n).toBe(1);
  }, 30_000);
});
