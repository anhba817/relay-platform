import "reflect-metadata";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { connect } from "nats";
import { createLogger, type Logger } from "@relay/service-kit";
import { subjectFor } from "@relay/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import { claimEvent, timesHandled } from "../db/repository";
import { ensureStream } from "../outbox/jetstream.publisher";
import { createConsumerRuntime } from "./runtime";
import type { EventHandler } from "./handler";

// The consumer, against a real broker and a real database (chapter 3.4).
//
// Every durable name here is unique per run. A durable consumer is a POSITION
// in a shared stream that already holds tens of thousands of events from earlier
// chapters — two runs sharing a name would inherit each other's progress, and
// the second would look mysteriously empty. This is the same lesson 2.6 learned
// about Redis subjects and 3.3 about the outbox table: a shared store needs a
// per-run handle, because the isolation every other suite gets from a tenant
// column is not available here.

const silent: Logger = createLogger("consumer-itest", () => {});

const ENV = () => randomUUID();

/** Publish one event straight onto the stream, the way the relay would. */
async function publish(
  environmentId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const nc = await connect({
    servers: process.env.RELAY_NATS_URL ?? "nats://localhost:4222",
  });
  const id = randomUUID();
  const payload = {
    id,
    type: "message.created",
    environment_id: environmentId,
    occurred_at: new Date().toISOString(),
    data: {
      id: randomUUID(),
      channel_id: randomUUID(),
      seq: 1,
      user: "tuan",
      text: "B2, north ramp",
      created_at: new Date().toISOString(),
    },
    ...overrides,
  };
  await nc
    .jetstream()
    .publish(
      subjectFor("message.created", environmentId),
      new TextEncoder().encode(JSON.stringify(payload)),
      { msgID: id },
    );
  await nc.drain();
  return id;
}

/** Publish something that is not an event at all. */
async function publishGarbage(environmentId: string): Promise<void> {
  const nc = await connect({
    servers: process.env.RELAY_NATS_URL ?? "nats://localhost:4222",
  });
  await nc
    .jetstream()
    .publish(
      subjectFor("message.created", environmentId),
      new TextEncoder().encode("{ this is not an event }"),
    );
  await nc.drain();
}

/** A runtime whose durable name is unique to this test, filtered to one
 * environment's subject so the stream's existing backlog stays out of the way. */
function runtimeFor(
  db: Db,
  durable: string,
  handler: EventHandler,
  logger: Logger = silent,
  environmentId?: string,
) {
  return createConsumerRuntime({
    durable,
    handler,
    logger,
    db,
    // Scoped to one environment's subject. Without it every test here would
    // replay the ~13,000 events earlier chapters left in the stream before
    // reaching its own — which is what `limits` retention means, and is exactly
    // the behaviour invariant 9 asserts on deliberately.
    ...(environmentId
      ? { filterSubject: subjectFor("message.created", environmentId) }
      : {}),
  });
}

/** The prefix every durable this suite names in-process carries. Unique per RUN,
 * and — the part that was missing — unique to THIS SUITE.
 *
 * The cleanup below deletes by prefix, and `itest-` was never this suite's to
 * claim. The dispatcher's own integration suite names its expand consumer
 * `itest-expand-<run>` on the SAME `EVENTS` stream, and under Turborepo the two
 * suites run at the same time against the same broker. So this suite's teardown
 * deleted a live consumer belonging to another suite mid-run, and whichever
 * dispatcher test happened to be polling failed with `NatsError: consumer
 * deleted` — or, for the next test along, `consumer not found`. It reproduced on
 * two of three full-lane runs and never once when the dispatcher suite ran
 * alone, which is what a cross-suite race looks like from the outside.
 *
 * The comment on `spawnedDurables` below had already written down the rule that
 * would have prevented this: a prefix sweep deletes things it did not create.
 * That reasoning was applied to the walk's durables and not to this suite's own.
 * Found by chapter 3.6's baseline.
 *
 * Two names, because they answer two different questions. `SUITE` is what the
 * teardown sweeps — this suite's whole namespace, so a run that crashed before
 * its own teardown is still tidied up by the next one. `RUN` is what the durables
 * are actually called, so two runs never share a position. Sweeping `RUN` alone
 * would leak every crashed run's consumers forever, which is the leak this
 * teardown was written to stop. */
const SUITE = "itest-consumer";
const RUN = `${SUITE}-${randomUUID().slice(0, 8)}`;

/** Durables this suite created through a CHILD process rather than directly.
 * The walk names its own — `walk-<uuid>` — so the suite cannot predict them and
 * a prefix sweep would delete a reader's walk running alongside it. It records
 * what it spawned instead, and cleans exactly that. */
const spawnedDurables: string[] = [];

/** Run the walk in its kill mode and SIGKILL it the moment it says it is in the
 * gap between the committed effect and the acknowledgement. */
async function killInTheGap(): Promise<{
  durable: string;
  eventId: string;
  environmentId: string;
}> {
  const script = join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "scripts",
    "consumer-walk.mjs",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [script, "--kill-before-ack", "--pause=30000"],
      { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let killed = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no marker within 60s; output was:\n${out}`));
    }, 60_000);
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
      if (!killed) return reject(new Error(`child finished early:\n${out}`));
      const durable = /durable consumer\s+(\S+)/.exec(out)?.[1];
      const eventId = /published\s+(\S+)/.exec(out)?.[1];
      const environmentId = /environment\s+([0-9a-f-]{36})/.exec(out)?.[1];
      if (!durable || !eventId) {
        return reject(new Error(`could not read the walk's output:\n${out}`));
      }
      spawnedDurables.push(durable);
      resolve({ durable, eventId, environmentId: environmentId ?? "" });
    });
  });
}

describe("the consumer", () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(createPool());
    const nc = await connect({
      servers: process.env.RELAY_NATS_URL ?? "nats://localhost:4222",
    });
    await ensureStream(nc);
    await nc.drain();
  }, 60_000);

  afterAll(async () => {
    await db.execute(`DELETE FROM consumed_events WHERE consumer LIKE '${SUITE}-%'`);
    for (const durable of spawnedDurables) {
      await db.execute(
        `DELETE FROM consumed_events WHERE consumer = '${durable}'`,
      );
    }
    // And the durable consumers themselves. A durable is server-side state that
    // outlives the process that made it: without this, every run of this suite
    // left another handful behind on a shared broker, and `stream-info.mjs`
    // found twelve of them the first time it looked. Per-run names keep runs
    // independent; they do not clean up after themselves.
    //
    // Both kinds go: the ones this process named `${RUN}-…`, and the `walk-…`
    // ones its child processes named for themselves. Missing the second kind is
    // how the first count reached twelve.
    //
    // The prefix is this SUITE's, not `itest-`. Sweeping `itest-` deleted another
    // suite's live consumer off this same stream — see `RUN` above.
    const nc = await connect({
      servers: process.env.RELAY_NATS_URL ?? "nats://localhost:4222",
    });
    const jsm = await nc.jetstreamManager();
    for await (const info of jsm.consumers.list("EVENTS")) {
      if (info.name.startsWith(SUITE) || spawnedDurables.includes(info.name)) {
        await jsm.consumers.delete("EVENTS", info.name).catch(() => undefined);
      }
    }
    await nc.drain();
  }, 60_000);

  it("invariant 1: the stream's settings read back exactly as configured", async () => {
    const nc = await connect({
      servers: process.env.RELAY_NATS_URL ?? "nats://localhost:4222",
    });
    const info = await (await nc.jetstreamManager()).streams.info("EVENTS");
    const c = info.config;
    expect(c.subjects).toEqual(["events.>"]);
    // NFR-REL-08's floor is 24 hours; the chapter chose seven days so a Friday
    // outage survives the weekend.
    expect(c.max_age).toBe(7 * 24 * 60 * 60 * 1_000_000_000);
    expect(c.max_bytes).toBe(1024 * 1024 * 1024);
    expect(c.discard).toBe("old");
    // Immutable once created, and both already right because 3.3 chose them.
    expect(c.retention).toBe("limits");
    expect(c.storage).toBe("file");
    await nc.drain();
  });

  it("invariant 2: applying the configuration twice is a no-op, not an error", async () => {
    const nc = await connect({
      servers: process.env.RELAY_NATS_URL ?? "nats://localhost:4222",
    });
    const before = await (await nc.jetstreamManager()).streams.info("EVENTS");
    await ensureStream(nc);
    await ensureStream(nc);
    const after = await (await nc.jetstreamManager()).streams.info("EVENTS");
    // Same settings, and — the part that matters on a stream holding tens of
    // thousands of events — nothing lost.
    expect(after.config.max_age).toBe(before.config.max_age);
    expect(after.state.messages).toBeGreaterThanOrEqual(before.state.messages);
    await nc.drain();
  });

  it("invariant 3: an event is delivered, handled once, and acknowledged", async () => {
    const environmentId = ENV();
    const durable = `${RUN}-basic-${Date.now()}`;
    const seen: string[] = [];
    const eventId = await publish(environmentId);

    const runtime = runtimeFor(
      db,
      durable,
      async (event) => {
        seen.push(event.id);
      },
      silent,
      environmentId,
    );
    for (let i = 0; i < 20 && !seen.includes(eventId); i++) {
      await runtime.pollOnce();
    }
    await runtime.stop();

    expect(seen.filter((id) => id === eventId)).toHaveLength(1);
    expect(await timesHandled(db, durable, eventId)).toBe(1);
  }, 120_000);

  it("invariant 4: a kill between handling and acknowledgement is redelivered — and handled once (SC-003)", async () => {
    // The chapter's centrepiece. The walk claims the event (which commits the
    // effect), prints its marker, and is SIGKILLed before it acknowledges.
    // The broker is entitled to redeliver — it never heard an acknowledgement —
    // and the ledger is what makes the redelivery safe.
    //
    // A real signal from the parent, not a thrown exception: an exception runs
    // the error path, and a crash does not (research R7, the shape 3.3 used).
    const { durable, eventId, environmentId } = await killInTheGap();

    // What the kill left behind: handled once, never acknowledged.
    expect(await timesHandled(db, durable, eventId)).toBe(1);

    // Now let a runtime pick up where the corpse left off. The broker redelivers
    // after ack_wait; the ledger refuses the claim; the message is acknowledged
    // because it genuinely has been handled.
    let redeliveries = 0;
    let handlerRuns = 0;
    const runtime = createConsumerRuntime({
      durable,
      db,
      logger: silent,
      filterSubject: subjectFor("message.created", environmentId),
      handler: async () => {
        handlerRuns += 1;
      },
    });
    for (let i = 0; i < 90; i++) {
      const { duplicates } = await runtime.pollOnce();
      redeliveries += duplicates;
      if (redeliveries > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await runtime.stop();

    // Redelivered, recognised, and NOT handled a second time.
    expect(redeliveries).toBeGreaterThan(0);
    expect(handlerRuns).toBe(0);
    expect(await timesHandled(db, durable, eventId)).toBe(1);

    await db.execute(`DELETE FROM consumed_events WHERE consumer = '${durable}'`);
  }, 180_000);

  it("invariant 5: deduplication survives a restart", async () => {
    // The ledger is in Postgres precisely so that a process restart does not
    // reset it. A second runtime with the same durable name gets the same
    // answer the first one would have.
    const durable = `${RUN}-restart-${Date.now()}`;
    const eventId = randomUUID();

    expect(await claimEvent(db, durable, eventId, async () => {})).toBe(
      "handled",
    );
    expect(await claimEvent(db, durable, eventId, async () => {})).toBe(
      "duplicate",
    );
    expect(await timesHandled(db, durable, eventId)).toBe(1);
  });

  it("invariant 6: two instances sharing a durable name divide the work", async () => {
    // The ordinary deployment. A durable consumer is one position in the stream,
    // so two api processes pulling from it share the work — the property the
    // broker provides here that `SKIP LOCKED` provides for the outbox.
    const durable = `${RUN}-shared-${Date.now()}`;
    const byA: string[] = [];
    const byB: string[] = [];
    const ids = [
      await publish(ENV()),
      await publish(ENV()),
      await publish(ENV()),
    ];

    const a = runtimeFor(db, durable, async (e) => void byA.push(e.id));
    const b = runtimeFor(db, durable, async (e) => void byB.push(e.id));
    for (let i = 0; i < 400; i++) {
      await Promise.all([a.pollOnce(), b.pollOnce()]);
      if (ids.every((id) => byA.includes(id) || byB.includes(id))) break;
    }
    await a.stop();
    await b.stop();

    for (const id of ids) {
      // Exactly one of them handled it, and the ledger agrees.
      const handledBoth =
        byA.filter((x) => x === id).length + byB.filter((x) => x === id).length;
      expect(handledBoth).toBe(1);
      expect(await timesHandled(db, durable, id)).toBe(1);
    }
  }, 120_000);

  it("invariant 7: a handler that always throws stops being retried", async () => {
    // `max_deliver` is 5. After that the broker stops delivering and the message
    // leaves the consumer's view — measured in research R4, and the honest
    // answer this chapter gives rather than a dead-letter path that does not
    // exist yet.
    const environmentId = ENV();
    const durable = `${RUN}-poison-${Date.now()}`;
    const eventId = await publish(environmentId);
    let attempts = 0;

    const runtime = runtimeFor(
      db,
      durable,
      async (event) => {
        if (event.id === eventId) {
          attempts += 1;
          throw new Error("this handler never succeeds");
        }
      },
      silent,
      environmentId,
    );
    for (let i = 0; i < 60 && attempts < 6; i++) {
      await runtime.pollOnce();
      await new Promise((r) => setTimeout(r, 50));
    }
    await runtime.stop();

    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(5);
    // And nothing was recorded as handled: a failed handler rolls its claim back
    // with it, which is what makes the retry a real retry.
    expect(await timesHandled(db, durable, eventId)).toBe(0);
  }, 180_000);

  it("invariant 8: an unparseable payload is terminated on the first attempt", async () => {
    // Retrying malformed bytes five times changes nothing about them. The
    // runtime terminates the message instead of burning the budget and dropping
    // it anyway — and says so in a log line carrying no payload.
    const environmentId = ENV();
    const durable = `${RUN}-garbage-${Date.now()}`;
    const lines: string[] = [];
    const noisy = createLogger("consumer-itest", (line) =>
      lines.push(typeof line === "string" ? line : JSON.stringify(line)),
    );
    await publishGarbage(environmentId);
    const marker = await publish(environmentId);

    let sawMarker = false;
    const runtime = runtimeFor(
      db,
      durable,
      async (event) => {
        if (event.id === marker) sawMarker = true;
      },
      noisy,
      environmentId,
    );
    for (let i = 0; i < 20 && !sawMarker; i++) await runtime.pollOnce();
    await runtime.stop();

    expect(sawMarker).toBe(true);
    const unparseable = lines.filter((l) => l.includes("consumer.unparseable"));
    expect(unparseable.length).toBe(1);
    expect(unparseable.join("")).not.toContain("this is not an event");
  }, 180_000);

  it("invariant 9: a consumer stopped for N publishes receives all N on restart", async () => {
    // What `limits` retention means: the stream holds messages whether or not
    // anybody is reading. The backlog waits.
    const durable = `${RUN}-catchup-${Date.now()}`;
    const seen: string[] = [];
    const runtime = runtimeFor(db, durable, async (e) => void seen.push(e.id));

    // Get to the head of the stream first, so "everything published while away"
    // is measurable rather than lost in twelve thousand older events.
    for (let i = 0; i < 800; i++) {
      const { handled, duplicates } = await runtime.pollOnce();
      if (handled + duplicates === 0) break;
    }
    await runtime.stop();

    const published = [
      await publish(ENV()),
      await publish(ENV()),
      await publish(ENV()),
    ];

    const restarted = runtimeFor(db, durable, async (e) => void seen.push(e.id));
    for (let i = 0; i < 100; i++) {
      await restarted.pollOnce();
      if (published.every((id) => seen.includes(id))) break;
    }
    await restarted.stop();

    for (const id of published) expect(seen).toContain(id);
  }, 240_000);

  it("invariant 12: a consumer log line carries counts, never payloads", async () => {
    const environmentId = ENV();
    const durable = `${RUN}-logs-${Date.now()}`;
    const lines: string[] = [];
    const noisy = createLogger("consumer-itest", (line) =>
      lines.push(typeof line === "string" ? line : JSON.stringify(line)),
    );
    const eventId = await publish(environmentId, {
      data: {
        id: randomUUID(),
        channel_id: randomUUID(),
        seq: 1,
        user: "tuan",
        text: "a secret worth keeping out of logs",
        created_at: new Date().toISOString(),
      },
    });

    let seen = false;
    const runtime = runtimeFor(
      db,
      durable,
      async (event) => {
        if (event.id === eventId) seen = true;
      },
      noisy,
      environmentId,
    );
    for (let i = 0; i < 20 && !seen; i++) await runtime.pollOnce();
    runtime.start();
    await new Promise((r) => setTimeout(r, 300));
    await runtime.stop();

    expect(lines.join("\n")).not.toContain("a secret worth keeping out of logs");
  }, 180_000);
});
