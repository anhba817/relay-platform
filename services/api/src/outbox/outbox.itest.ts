import "reflect-metadata";

import { spawn } from "node:child_process";
import { join } from "node:path";

import { createLogger, type Logger } from "@relay/service-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import {
  createEnvironment,
  outboxDepth,
  Repository,
} from "../db/repository";
import { createJetStreamPublisher } from "./jetstream.publisher";
import { createRelay } from "./relay";
import type { Publisher, PublishedMessage } from "./publisher";

// The outbox, against the real database (chapter 3.3). Invariants 1-4, 7-8 and
// 11 live here; the crash cases (5, 6, 10) and the broker outage (9) are added
// below, because both need a process to kill or a container to stop.
//
// The relay is driven by hand — `drainOnce()`, the same code path the loop runs
// — so these assertions are deterministic. The background loop is off in this
// lane (RELAY_OUTBOX_RELAY=off); a loop marking rows published mid-assertion
// would make every test here flaky for no teaching value.

const silent: Logger = createLogger("outbox-itest", () => {});

/** A destination that is not a broker. Same shape the port promises, so the
 * relay cannot tell the difference — which is invariant 12, exercised here as a
 * side effect of every other test. */
function recordingPublisher(): Publisher & {
  sent: PublishedMessage[];
  failNext: (times: number) => void;
} {
  const sent: PublishedMessage[] = [];
  let failures = 0;
  return {
    sent,
    failNext(times: number) {
      failures = times;
    },
    async publish(message) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("broker unreachable");
      }
      sent.push(message);
    },
    async close() {},
  };
}

const unpublishedFor = async (db: Db, environmentId: string) => {
  const rows = (await db.execute(
    `SELECT id, subject, payload FROM outbox
      WHERE published_at IS NULL
        AND payload->>'environment_id' = '${environmentId}'
      ORDER BY id`,
  )) as unknown as { rows: { id: number; subject: string; payload: { id: string; data: { seq: number; user: string | null; text: string } } }[] };
  return rows.rows;
};

describe("the outbox", () => {
  let db: Db;
  let env: { id: string };
  let repo: Repository;
  let channelId: string;
  let tuan: { id: string };

  beforeAll(async () => {
    db = createDb(createPool());
    env = await createEnvironment(db, { name: `outbox-itest-${Date.now()}` });
    repo = new Repository(db, env.id);
    tuan = await repo.createUser("tuan", "Tuan");
    channelId = (await repo.createChannel("fleet", "public")).id;
    await repo.addMember(channelId, tuan.id);
  }, 60_000);

  afterAll(async () => {
    // Leave the table as we found it for this environment, so a rerun starts
    // from zero rather than from the last run's backlog.
    await db.execute(
      `DELETE FROM outbox WHERE payload->>'environment_id' = '${env.id}'`,
    );
  });

  it("invariant 1: a committed message leaves exactly one outbox row", async () => {
    const before = await unpublishedFor(db, env.id);
    const message = await repo.sendMessage(channelId, {
      text: "B2, north ramp",
      userId: tuan.id,
      userExternalId: "tuan",
    });
    const after = await unpublishedFor(db, env.id);
    expect(after.length).toBe(before.length + 1);

    const row = after.at(-1)!;
    expect(row.subject).toBe(`events.msg.created.${env.id}`);
    expect(row.payload.data.seq).toBe(message.seq);
    expect(row.payload.data.text).toBe("B2, north ramp");
    expect(row.payload.data.user).toBe("tuan");
  });

  it("invariant 2: a rolled-back write leaves no outbox row", async () => {
    const before = await unpublishedFor(db, env.id);
    // The transaction fails AFTER the message and its event are written: the
    // channel does not exist in this tenant, so sendMessage throws before it
    // commits. Event and state change share a fate.
    await expect(
      repo.sendMessage("00000000-0000-0000-0000-000000000000", {
        text: "never happened",
        userId: tuan.id,
        userExternalId: "tuan",
      }),
    ).rejects.toThrow();
    expect((await unpublishedFor(db, env.id)).length).toBe(before.length);
  });

  it("invariant 3: a recognised idempotent retry adds no second event", async () => {
    // 2.3's conflict path returns the ORIGINAL message and writes nothing. It
    // must consume no event either — otherwise a client retrying on a flaky
    // link fires two webhooks for one message (FR-MSG-04, research R1).
    const before = await unpublishedFor(db, env.id);
    const key = `retry-${Date.now()}`;
    const first = await repo.sendMessage(channelId, {
      text: "sent twice",
      userId: tuan.id,
      userExternalId: "tuan",
      idempotencyKey: key,
    });
    const afterFirst = await unpublishedFor(db, env.id);
    expect(afterFirst.length).toBe(before.length + 1);

    const retry = await repo.sendMessage(channelId, {
      text: "sent twice",
      userId: tuan.id,
      userExternalId: "tuan",
      idempotencyKey: key,
    });
    expect(retry.duplicate).toBe(true);
    expect(retry.seq).toBe(first.seq);
    expect((await unpublishedFor(db, env.id)).length).toBe(afterFirst.length);
  });

  it("invariant 4: both doors produce one event each, identical in shape", async () => {
    // The public REST route and the socket's internal route reach ONE write
    // path (ADR-04), so this is true by construction — and the test exists to
    // notice the day someone adds a second path.
    const before = await unpublishedFor(db, env.id);
    await repo.sendMessage(channelId, {
      text: "through the socket",
      userId: tuan.id,
      userExternalId: "tuan",
    });
    // The key-authenticated public send is unattributed (3.2's recorded bound),
    // which is a CONTENT difference, not a shape one.
    await repo.sendMessage(channelId, { text: "through REST", userId: tuan.id });
    const rows = (await unpublishedFor(db, env.id)).slice(before.length);
    expect(rows.length).toBe(2);
    const shapes = rows.map((r) => Object.keys(r.payload).sort().join(","));
    expect(shapes[0]).toBe(shapes[1]);
    expect(rows[0]!.payload.data.user).toBe("tuan");
    expect(rows[1]!.payload.data.user).toBeNull();
  });

  it("invariant 7: the relay publishes pending rows, marks them, and does not republish", async () => {
    const publisher = recordingPublisher();
    const relay = createRelay({ db, publisher, logger: silent });

    const pending = await unpublishedFor(db, env.id);
    expect(pending.length).toBeGreaterThan(0);

    const published = await drainUntilClear(relay, db, env.id);
    expect(published).toBeGreaterThanOrEqual(pending.length);
    expect((await unpublishedFor(db, env.id)).length).toBe(0);

    // Every event this environment produced reached the destination with its
    // own id as the deduplication key.
    //
    // SCOPED, and it was not (feature 030, instance 9). `publisher.sent` holds
    // every row this relay moved out of a table it drains globally, so the
    // unfiltered version asserted that no row anywhere in the outbox is ever
    // published twice by anybody — which is a claim about the whole platform
    // dressed up as a claim about three messages. It failed once in a full lane
    // run, `expected 3001 to be 4800`, and passed when the file ran alone: the
    // recurring fault's signature. The scoped idiom is the one this file already
    // uses forty lines down, and the sentence above the assertion was describing
    // it all along.
    const ids = publisher.sent
      .filter((m) => m.subject.endsWith(env.id))
      .map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);

    // A second pass has nothing of OURS to do — marked rows are done.
    //
    // Asserted per environment, not on the global count: `drainOnce()` returns
    // how many rows it moved across the whole table, and other suites in this
    // lane are writing events the entire time. The row-level property being
    // tested is "a marked row is never sent again", so that is what the
    // assertion says.
    const oursBefore = publisher.sent.filter((m) =>
      m.subject.endsWith(env.id),
    ).length;
    await relay.drainOnce();
    const oursAfter = publisher.sent.filter((m) =>
      m.subject.endsWith(env.id),
    ).length;
    expect(oursAfter).toBe(oursBefore);
    expect((await unpublishedFor(db, env.id)).length).toBe(0);
  });

  it("invariant 8: two concurrent relays publish every row exactly once", async () => {
    // `FOR UPDATE SKIP LOCKED` is the whole mechanism: competing drainers skip
    // each other's claimed rows rather than blocking on them. Two api instances
    // is the ORDINARY deployment, not an edge case.
    for (let i = 0; i < 20; i++) {
      await repo.sendMessage(channelId, {
        text: `concurrent ${i}`,
        userId: tuan.id,
        userExternalId: "tuan",
      });
    }
    const a = recordingPublisher();
    const b = recordingPublisher();
    const relayA = createRelay({ db, publisher: a, logger: silent, batchSize: 7 });
    const relayB = createRelay({ db, publisher: b, logger: silent, batchSize: 7 });

    // Run them at the same time, repeatedly, until THIS environment's backlog is
    // gone. Same reader fix as `drainUntilClear`, and sharper here: `batchSize: 7`
    // made twenty passes a budget of 140 rows, against a table holding thousands.
    // The loop ends when our rows are done or when neither relay can move
    // anything.
    for (;;) {
      if ((await outboxDepthFor(db, env.id)) === 0) break;
      const [movedA, movedB] = await Promise.all([
        relayA.drainOnce(),
        relayB.drainOnce(),
      ]);
      if (movedA + movedB === 0) break;
    }

    expect(await outboxDepthFor(db, env.id)).toBe(0);
    const all = [...a.sent, ...b.sent].map((m) => m.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("invariant 11: a relay log line carries counts, never payloads", async () => {
    // A message body in a log is a tenant's data in an operator's terminal
    // (NFR-SEC-06). The relay logs what it did, not what it moved.
    const lines: string[] = [];
    const noisy: Logger = createLogger("outbox-itest", (line) =>
      lines.push(typeof line === "string" ? line : JSON.stringify(line)),
    );
    await repo.sendMessage(channelId, {
      text: "a secret worth keeping out of logs",
      userId: tuan.id,
      userExternalId: "tuan",
    });
    const relay = createRelay({
      db,
      publisher: recordingPublisher(),
      logger: noisy,
    });
    await relay.drainOnce();
    // The relay's own logging happens in the loop, so drive one iteration of it
    // the way production does.
    relay.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await relay.stop();

    const haystack = lines.join("\n");
    expect(haystack).not.toContain("a secret worth keeping out of logs");
    expect(haystack).not.toContain("north ramp");
  });

  it("invariant 6: publish-after-commit LOSES the event when the process dies in the gap (SC-003)", async () => {
    // The chapter's opening failure, reproduced. The naive walk commits its
    // messages and is killed before it publishes. Afterwards the messages are
    // there and there is NO durable record that an event was ever owed — no
    // row, no error, nothing to replay from. That silence is the whole problem:
    // a message was sent, no webhook will fire, and nothing anywhere knows.
    const environmentId = await killInTheGap("naive");

    const messages = (await db.execute(
      `SELECT count(*)::int AS n FROM messages m
         JOIN channels c ON c.id = m.channel_id
        WHERE c.environment_id = '${environmentId}'`,
    )) as unknown as { rows: { n: number }[] };
    expect(messages.rows[0]!.n).toBeGreaterThan(0);

    const owed = (await db.execute(
      `SELECT count(*)::int AS n FROM outbox
        WHERE payload->>'environment_id' = '${environmentId}'`,
    )) as unknown as { rows: { n: number }[] };
    expect(owed.rows[0]!.n).toBe(0);
  }, 60_000);

  it("invariant 5: the outbox SURVIVES the same kill, and invariant 10's id survives with it (SC-002)", async () => {
    // Same script, same signal, same moment. The difference is that the event
    // committed with the message, so it is still here — pending, addressed, and
    // carrying the deduplication key it was born with.
    const environmentId = await killInTheGap("outbox");

    const rows = (await db.execute(
      `SELECT id, subject, payload FROM outbox
        WHERE published_at IS NULL AND payload->>'environment_id' = '${environmentId}'
        ORDER BY id`,
    )) as unknown as {
      rows: { id: number; subject: string; payload: { id: string } }[];
    };
    expect(rows.rows.length).toBeGreaterThan(0);
    const survivor = rows.rows[0]!;
    expect(survivor.subject).toBe(`events.msg.created.${environmentId}`);
    expect(survivor.payload.id).toMatch(/^[0-9a-f-]{36}$/);

    // Recovery needs no operator: a relay started afterwards publishes it, with
    // the SAME id the row was written with — which is invariant 10's integration
    // half. A deduplication key that changed on retry would make every
    // consumer's dedupe useless.
    const publisher = recordingPublisher();
    const relay = createRelay({ db, publisher, logger: silent });
    expect(
      await drainUntilClear(relay, db, environmentId),
    ).toBeGreaterThan(0);
    expect(publisher.sent.map((m) => m.id)).toContain(survivor.payload.id);

    await db.execute(
      `DELETE FROM outbox WHERE payload->>'environment_id' = '${environmentId}'`,
    );
  }, 60_000);

  it("invariant 9: the broker can be absent — writes succeed, events accumulate, the backlog drains (SC-007)", async () => {
    // SAD §7 claims exactly this: "broker down, events accumulate in Postgres,
    // relay drains on recovery". The claim is tested here rather than quoted.
    //
    // "Down" is a publisher pointed at a port with nothing behind it, driving
    // the REAL JetStream client — so the failure path under test is the client's
    // own connect failure, not a fake's throw.
    const down = createJetStreamPublisher({ url: "nats://127.0.0.1:14999" });
    const downRelay = createRelay({ db, publisher: down, logger: silent });

    // Writes do not care. This is the inversion an outbox exists to create: the
    // event spine is not a dependency of the write path (research R9).
    for (let i = 0; i < 3; i++) {
      const message = await repo.sendMessage(channelId, {
        text: `while the broker is down ${i}`,
        userId: tuan.id,
        userExternalId: "tuan",
      });
      expect(message.seq).toBeGreaterThan(0);
    }
    const backlog = await outboxDepthFor(db, env.id);
    expect(backlog).toBeGreaterThanOrEqual(3);

    // The relay cannot publish, and says so by failing rather than by marking.
    await expect(downRelay.drainOnce()).rejects.toThrow();
    expect(await outboxDepthFor(db, env.id)).toBe(backlog);
    await down.close();

    // The broker returns. Nobody intervenes; the same loop drains what piled up.
    const up = createJetStreamPublisher({
      url: process.env.RELAY_NATS_URL ?? "nats://localhost:14222",
    });
    const upRelay = createRelay({ db, publisher: up, logger: silent });
    const drained = await drainUntilClear(upRelay, db, env.id);
    expect(drained).toBeGreaterThanOrEqual(backlog);
    expect(await outboxDepthFor(db, env.id)).toBe(0);
    await up.close();

    // And the whole-table depth an operator would watch is a real number.
    expect(await outboxDepth(db)).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("a failing publisher leaves the row pending rather than losing it", async () => {
    // The publish-then-mark ordering, tested from the failure side: a broker
    // that refuses must not advance the cursor.
    const publisher = recordingPublisher();
    await repo.sendMessage(channelId, {
      text: "the broker will refuse this",
      userId: tuan.id,
      userExternalId: "tuan",
    });
    const depthBefore = await outboxDepthFor(db, env.id);
    expect(depthBefore).toBeGreaterThan(0);

    publisher.failNext(1);
    const relay = createRelay({ db, publisher, logger: silent });
    await expect(relay.drainOnce()).rejects.toThrow(/unreachable/);
    expect(await outboxDepthFor(db, env.id)).toBe(depthBefore);

    // And it drains on the next attempt, with nothing lost.
    //
    // The lane is quiet enough for this to be deterministic: the e2e journey's
    // api children run with the relay off, precisely so that two test files do
    // not race over one table. Within this file, `drainOnce()` is driven by
    // hand and nothing else publishes.
    expect(
      await drainUntilClear(relay, db, env.id),
    ).toBeGreaterThanOrEqual(depthBefore);
    expect(await outboxDepthFor(db, env.id)).toBe(0);
  });
});

/** Drain until this environment's backlog is gone.
 *
 * One `drainOnce()` is not enough, and the reason is worth stating: the relay is
 * deliberately NOT tenant-scoped — one loop drains every environment's events,
 * because an outbox row is work the platform owes itself. So a batch can be
 * filled entirely by rows this suite did not write, and a test that assumes
 * otherwise passes alone and fails in a full lane. (It did exactly that here.)
 * Suites cannot isolate themselves by construction on this table the way 2.1's
 * per-suite environments let them everywhere else. */
/*
 * READER FIX (feature 030). The comment above was right about the table and wrong
 * about the loop.
 *
 * `passes = 20` bounded the DRIVING in units of batches while the work is bounded
 * by the whole table. Twenty passes of the default batch move 2,000 rows; the
 * seeder's bait alone is 3,400, so the loop returned with this environment's rows
 * untouched and the assertion below reported `expected 4 to be +0` — a correctly
 * scoped read of a wrongly driven relay.
 *
 * There is no right constant here, which is the point: the relay is global and
 * oldest-first, so reaching this suite's rows means draining everything older than
 * them, and how much that is depends on who else is in the database. So the loop
 * has no pass budget. It stops on the only two conditions that mean anything —
 * this environment is clear, or a pass moved nothing and the relay is therefore
 * done — and each pass that moves rows reduces the global backlog, so it
 * terminates. `safety` exists to turn a hypothetical infinite loop into a failed
 * test, and is derived from the work that actually exists rather than guessed.
 */
async function drainUntilClear(
  relay: { drainOnce: () => Promise<number> },
  db: Db,
  environmentId: string,
): Promise<number> {
  let moved = 0;
  const safety = (await outboxDepth(db)) + 100;
  for (let i = 0; i < safety; i++) {
    if ((await outboxDepthFor(db, environmentId)) === 0) break;
    const drained = await relay.drainOnce();
    moved += drained;
    if (drained === 0) break;
  }
  return moved;
}

/** Run the walk in one mode and `SIGKILL` it the moment it says it is in the
 * gap between the commit and the publish.
 *
 * A real signal from the parent, not `process.exit()` from the child: a process
 * that exits cooperatively gets to flush, and flushing is the thing being
 * disproved. This is the difference between testing an error path and testing
 * durability (research R4). */
async function killInTheGap(mode: "naive" | "outbox"): Promise<string> {
  // `__dirname`, not `import.meta`: this service compiles to CommonJS under
  // NestJS (ADR-15), where the meta-property is a compile error.
  const script = join(__dirname, "..", "..", "..", "..", "scripts", "dual-write-walk.mjs");
  return new Promise((resolve, reject) => {
    // A 30-second pause the child never actually waits out: the parent kills it
    // the instant the marker appears. It was 3 seconds, and on a loaded lane the
    // signal occasionally arrived AFTER the pause elapsed — at which point the
    // child went on to drain the outbox, which is global, and published rows
    // other tests in this file were still asserting on. The window only needs to
    // exceed the parent's reaction time; making it long costs nothing because it
    // is never spent.
    const child = spawn("node", [script, `--mode=${mode}`, "--pause=30000"], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let killed = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no marker within 30s; output was:\n${out}`));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (!killed && out.includes("MARKER kill-me-now")) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("exit", () => {
      clearTimeout(timer);
      if (!killed) return reject(new Error(`child finished before the marker:\n${out}`));
      const env = /environment\s+(\S+)/.exec(out)?.[1];
      if (!env) return reject(new Error(`no environment in output:\n${out}`));
      resolve(env);
    });
  });
}

/** Depth for ONE environment. `outboxDepth` counts the whole table, which is
 * right for an operator and wrong for a test sharing a database with others. */
async function outboxDepthFor(db: Db, environmentId: string): Promise<number> {
  const result = (await db.execute(
    `SELECT count(*)::int AS pending FROM outbox
      WHERE published_at IS NULL
        AND payload->>'environment_id' = '${environmentId}'`,
  )) as unknown as { rows: { pending: number }[] };
  return result.rows[0]?.pending ?? 0;
}
