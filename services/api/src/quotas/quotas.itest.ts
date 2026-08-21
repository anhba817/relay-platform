import { randomUUID } from "node:crypto";

import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createDb, createPool, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import { createEnvironment, Repository, usageFor } from "../db/repository";
import { environments } from "../db/schema";
import { createLogger } from "@relay/service-kit";
import { createMailer } from "../notifications/mailer";
import { createQuotaRelay } from "./quota-relay";
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

// ---------------------------------------------------------------------------
// Chapter 3.10, User Story 3 — nobody is surprised.
// ---------------------------------------------------------------------------
//
// Read out of Mailpit rather than asserted on a send call, which is the shape
// chapter 3.9 established: only a received message can prove an email carries no
// secret, and only a received message proves it was sent at all.
//
// Mailpit is ONE SHARED INBOX for the whole lane, so every assertion filters by a
// per-test recipient address rather than reading "the latest message" — the
// mistake that makes a suite pass alone and fail beside another.

const mailpit = process.env["RELAY_MAILPIT_URL"] ?? "http://localhost:8025";

interface Received {
  ID: string;
  Subject: string;
}

async function inbox(address: string, expected = 1, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
    );
    const body = (await res.json()) as { messages: Received[] };
    if (body.messages.length >= expected || Date.now() > deadline) {
      return body.messages;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function bodyOf(id: string): Promise<string> {
  const res = await fetch(`${mailpit}/api/v1/message/${id}`);
  const b = (await res.json()) as { Text: string; Subject: string };
  return `${b.Subject}\n${b.Text}`;
}

describe("nobody is surprised", () => {
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

  /** An organisation with one addressable admin, and an environment under it. */
  const seed = async (addresses: (string | null)[]) => {
    const orgId = randomUUID();
    const appId = randomUUID();
    const envId = randomUUID();
    await db.execute(
      `INSERT INTO organisations (id,name) VALUES ('${orgId}','quota-org')`,
    );
    for (const address of addresses) {
      const humanId = randomUUID();
      await db.execute(
        `INSERT INTO humans (id,provider,provider_account_id,email)
         VALUES ('${humanId}','github','${humanId}',${address ? `'${address}'` : "NULL"})`,
      );
      await db.execute(
        `INSERT INTO memberships (organisation_id,human_id,role)
         VALUES ('${orgId}','${humanId}','owner')`,
      );
    }
    await db.execute(
      `INSERT INTO applications (id,organisation_id,name)
       VALUES ('${appId}','${orgId}','Fleet Ops')`,
    );
    await db.execute(
      `INSERT INTO environments (id,application_id,kind,signing_secret)
       VALUES ('${envId}','${appId}','production','x')`,
    );
    const repo = new Repository(db, envId);
    const channel = await repo.createChannel(`c-${randomUUID().slice(0, 8)}`, "public");
    const userId = (await repo.createUser(`u-${randomUUID().slice(0, 8)}`)).id;
    return { environmentId: envId, repo, channelId: channel.id, userId };
  };

  const relay = () =>
    createQuotaRelay({
      db,
      mailer: createMailer(),
      logger: createLogger("quotas-itest"),
      batchSize: 10_000,
    });

  const setCaps = async (environmentId: string, config: unknown) =>
    db
      .update(environments)
      .set({ quotaConfig: config as Record<string, unknown> })
      .where(eq(environments.id, environmentId));

  /** The percentages Mailpit holds for one address, ascending as NUMBERS.
   * Sorting the subjects as strings puts "100%" before "50%", which is the kind
   * of assertion that passes for the wrong reason and fails for a worse one. */
  const thresholdsIn = (got: Received[]): number[] =>
    got
      .map((m) => Number(/(\d+)%/.exec(m.Subject)?.[1] ?? 0))
      .sort((a, b) => a - b);

  it("sends exactly three emails per quota per period, and Mailpit has them", async () => {
    const address = `q-${randomUUID().slice(0, 8)}@example.test`;
    const { environmentId, repo, channelId, userId } = await seed([address]);
    await setCaps(environmentId, { messages: { hard: 4 } });

    // 1 of 4 = 25%, 2 = 50%, 3 = 75%, 4 = 100%. THREE crossings, not two: the
    // fourth message clears 80% and 100% in one step, because 80% of 4 is 3.2
    // and nothing lands on it. Written as two first, and the lane said three.
    for (const t of ["a", "b", "c", "d"]) {
      await repo.sendMessage(channelId, { text: t, userId });
    }
    expect(await relay().drainOnce()).toBeGreaterThan(0);

    expect(thresholdsIn(await inbox(address, 3))).toEqual([50, 80, 100]);
  }, 60_000);

  it("notifies every threshold a single send jumps over", async () => {
    // FR-016. One message can take a tenant from comfortable to suspended, and
    // all three emails are owed. 40% to 100% in one step.
    const address = `jump-${randomUUID().slice(0, 8)}@example.test`;
    const { environmentId, repo, channelId, userId } = await seed([address]);
    await setCaps(environmentId, { messages: { hard: 5 } });
    // 20, 40, 60, 80, 100 — the third message crosses 50, the fourth crosses 80,
    // the fifth crosses 100.
    for (const t of ["a", "b", "c", "d", "e"]) {
      await repo.sendMessage(channelId, { text: t, userId });
    }
    await relay().drainOnce();

    expect(thresholdsIn(await inbox(address, 3))).toEqual([50, 80, 100]);
  }, 60_000);

  it("sends no further email when a threshold is re-crossed", async () => {
    // FR-015, and the constraint is what enforces it, not this code path.
    const address = `once-${randomUUID().slice(0, 8)}@example.test`;
    const { environmentId, repo, channelId, userId } = await seed([address]);
    await setCaps(environmentId, { messages: { hard: 2 } });
    await repo.sendMessage(channelId, { text: "a", userId });
    await relay().drainOnce();
    const first = await inbox(address, 1);
    expect(first).toHaveLength(1);

    // Raise the cap so the same percentage is crossed again on the way up.
    await setCaps(environmentId, { messages: { hard: 4 } });
    await repo.sendMessage(channelId, { text: "b", userId });
    await relay().drainOnce();
    await new Promise((r) => setTimeout(r, 500));

    expect(await inbox(address, 99, 0)).toHaveLength(1);
  }, 60_000);

  it("records the crossing and enforces the cap for an organisation nobody can email", async () => {
    // FR-018. `humans.email` is nullable, so this is a state the schema permits
    // rather than a defensive `if`. The obligation is discharged as far as it
    // can be and the failure is logged rather than swallowed.
    const { environmentId, repo, channelId, userId } = await seed([null, null]);
    await setCaps(environmentId, { messages: { hard: 1 } });
    await repo.sendMessage(channelId, { text: "a", userId });

    expect(await relay().drainOnce()).toBeGreaterThan(0);
    await expect(
      repo.sendMessage(channelId, { text: "b", userId }),
    ).rejects.toThrow(QuotaExceededError);
  }, 60_000);

  it("carries no secret, key, credential or message text", async () => {
    const address = `leak-${randomUUID().slice(0, 8)}@example.test`;
    const { environmentId, repo, channelId, userId } = await seed([address]);
    await setCaps(environmentId, { messages: { hard: 1 } });
    await repo.sendMessage(channelId, { text: "B2, north ramp", userId });
    await relay().drainOnce();

    const [mail] = await inbox(address, 1);
    const text = await bodyOf(mail!.ID);
    for (const forbidden of ["B2, north ramp", "signing_secret", "rk_", environmentId]) {
      expect(text).not.toContain(forbidden);
    }
  }, 60_000);

  it("cannot fail a send when the mail server is gone", async () => {
    // FR-019. Writing a row is not sending one, and this is the requirement that
    // says so out loud. Chapter 3.9 met the same hazard from the other side,
    // where a drain's failure became a lane's failure.
    const address = `down-${randomUUID().slice(0, 8)}@example.test`;
    const { environmentId, repo, channelId, userId } = await seed([address]);
    await setCaps(environmentId, { messages: { hard: 1 } });

    // The send crosses 100% and must succeed regardless of any mail server.
    await expect(
      repo.sendMessage(channelId, { text: "a", userId }),
    ).resolves.toBeDefined();

    const down = createQuotaRelay({
      db,
      mailer: createMailer("smtp://127.0.0.1:1"),
      logger: createLogger("quotas-down"),
      batchSize: 10_000,
    });
    expect(await down.drainOnce()).toBe(0);

    // Still claimable: the row kept its null `delivered_at` and recorded why.
    const { rows } = (await db.execute(
      `SELECT delivered_at IS NULL AS claimable, last_error IS NOT NULL AS explained
         FROM quota_notifications WHERE environment_id = '${environmentId}'`,
    )) as unknown as { rows: { claimable: boolean; explained: boolean }[] };
    expect(rows[0]).toEqual({ claimable: true, explained: true });
  }, 60_000);
});
