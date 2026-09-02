import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { docsUrl, subjectForChannelMembership } from "@relay/protocol";
import { serve } from "@relay/service-kit";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { ApiClient } from "./api-client.js";
import { createFanout } from "./fanout.js";
import { createConnections, MAX_CONNECTIONS_PER_USER, type Connections } from "./connections.js";
import { createMembership } from "./membership.js";
import { attachSessions } from "./session.js";

// CHAPTER 3.22 — FR-RTM-09's five-connection cap.
//
// PHASE 2 IS US3 AND IT RUNS AGAINST UNCHANGED CODE, deliberately. FR-RTM-09's
// second clause — "each shall receive all events independently" — is a property
// of code that already ships: delivery walks connections, never users. Writing
// these tests BEFORE the cap exists makes them a regression guard for it.
// Written afterwards they would prove nothing, because nobody would know they
// had ever passed.
//
// A PER-RUN ENVIRONMENT, and not the constant the neighbours use. `typing.itest.ts`
// defaults to "env-1" and `resume.itest.ts` hardcodes it; both lean on the user
// name "tuan"; and the gateway's integration config sets no `fileParallelism`, so
// all three files run at once. Once Phase 5 lands, slot keys are namespaced by
// environment, and a constant here would leak this file's tests into each other.
const ENVIRONMENT = `env-${randomUUID()}`;
const REDIS = process.env["RELAY_REDIS_URL"] ?? "redis://localhost:6379";

const silent = { log: () => {} };

/** Every environment this run has booted an instance in — the one above, plus the
 * second one FR-012's test needs. Populated by `boot`, and read only by the sweep
 * below. */
const environments = new Set<string>();

/** T050c. **A SLOT'S TTL OUTLIVES THE PACKAGE'S RUN**: 60,000 ms of bound against
 * a gateway integration lane of about forty-five seconds. So a slot leaked by a
 * close handler that never ran survives into the next file and into the next
 * battery run — and this is the only file that deliberately fills all five.
 *
 * Scoped to this run's own environment prefixes, which are UUIDs, so it cannot
 * touch another suite's keys. `limits.itest.ts:297` deletes its three rate-limit
 * keys by name for the same reason and is the only other Redis cleanup in the
 * gateway's integration files; a name list is not available here because the
 * production code chooses the user and the slot. */
const raw = new Redis(REDIS);

afterEach(async () => {
  for (const environment of environments) {
    const keys = await raw.keys(`conn:${environment}:*`);
    if (keys.length > 0) await raw.del(...keys);
  }
});

afterAll(async () => {
  await raw.quit();
});

interface Instance {
  url: string;
  /** FR-011a's path ON ITS OWN, with the sockets left open — which is the only way
   * to see it. `sessions.close()` calls `releaseAll()` and then `wss.close()`, and
   * `wss.close()` does not close established sockets; the fixture's own `close()`
   * below waits on `server.close()`, which does not return while a socket is open.
   * So a test that wants to observe the deploy path calls this and leaves the rest
   * to teardown. */
  shutdown: () => Promise<void>;
  /** FR-007. The instance stops being able to reach the registry, and nothing
   * closes its sockets.
   *
   * **WHAT A `kill -9` LOOKS LIKE FROM REDIS'S SIDE, which is the only side that
   * can see it**: no release lands, no renewal lands, and the five keys sit there
   * until their bound elapses. In process there is no way to make the server's own
   * `close` handlers not run — destroying the socket is what triggers them — so the
   * simulation is at the registry rather than at the socket. It does not reproduce
   * a half-written command or a torn connection, and it is not claimed to. */
  crash: () => Promise<void>;
  close: () => Promise<void>;
}

/** One gateway, in process, with a stubbed api — the shape `resume.itest.ts` and
 * `typing.itest.ts` use. No api is spawned, so this file claims no port range and
 * adds nothing to the seven spawning files in the lane. */
async function boot(options: {
  user: string;
  channels: string[];
  /** FR-012's test needs a second one, and every other test wants this run's own.
   * `typing.itest.ts:94` defaults to `"env-1"` and `resume.itest.ts` hardcodes it
   * in seven places; both lean on the user name "tuan". Those two claim no slots,
   * so the reason here is hygiene within this file rather than a collision with
   * them — but this file fills all five places on purpose, and a shared identity
   * would leak one test's slots into the next. */
  environment?: string;
  /** Chapter 3.22, T050a. **ONE MODULE PER INSTANCE, BUILT HERE**, the way
   * `typing.itest.ts:101` calls `createTyping(...)` inside `boot()`.
   *
   * `releaseAll()` is what makes this correctness rather than style: it frees the
   * places *this instance* holds, so a fixture sharing one module across two
   * gateways would have the crashed instance release the surviving one's slots —
   * and T052 would pass for the wrong reason. Two instances, two modules, two
   * client pairs, both closed in teardown.
   *
   * Absent means the cap is not enforced at all, which is what US3's tests want:
   * every gateway module is an optional `attachSessions` parameter, so a fixture
   * opts in. */
  cap?: { boundMs?: number; heartbeatMs?: number };
  /** FR-015's log line is the assertion that carries the requirement, so a test
   * needs the lines. Chapter 3.18: a publisher that does nothing satisfies "the
   * send returned 201". */
  lines?: Record<string, unknown>[];
}): Promise<Instance> {
  const environment = options.environment ?? ENVIRONMENT;
  environments.add(environment);
  const fanout = createFanout({ url: REDIS, logger: silent });
  const membership = createMembership({ url: REDIS, logger: silent });
  const logger =
    options.lines === undefined
      ? silent
      : {
          log: (_level: string, msg: string, fields?: Record<string, unknown>) => {
            options.lines?.push({ msg, ...fields });
          },
        };
  const server: Server = serve({
    service: "gateway",
    health: () => ({}),
    logger: silent,
    notFoundDocsUrl: docsUrl("not_found"),
  });
  const api: ApiClient = {
    session: async () => ({
      environment_id: environment,
      user: options.user,
      banned: false,
      channel_ids: options.channels,
      limits: { connect: 3_000, send: 600 },
    }),
    memberships: async () => options.channels,
    backfill: async () => ({}) as never,
    sendMessage: async () => {
      throw new Error("not used");
    },
    reportUsage: async () => null,
  };
  const registry: Connections | undefined =
    options.cap === undefined
      ? undefined
      : createConnections({
          url: REDIS,
          logger,
          ...(options.cap.boundMs === undefined ? {} : { boundMs: options.cap.boundMs }),
        });
  const sessions = attachSessions({
    server,
    api,
    logger,
    fanout,
    membership,
    ...(registry === undefined ? {} : { connections: registry }),
    ...(options.cap?.heartbeatMs === undefined
      ? {}
      : { heartbeatMs: options.cap.heartbeatMs }),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await sessions.close();
  };
  return {
    url: `ws://127.0.0.1:${port}/v1/ws`,
    shutdown: stop,
    // Only the client goes. Teardown then runs the ordinary path, where every
    // release and every `releaseAll` throws inside the module's own `failable` and
    // is logged rather than thrown — so the timers still get cleared and the slots
    // still stay held.
    crash: async () => {
      await registry?.close().catch(() => {});
    },
    close: async () => {
      await stop();
      await fanout.close();
      await membership.close();
      await registry?.close().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Recorded {
  socket: WebSocket;
  frames: { type: string; payload: Record<string, unknown> }[];
}

/** Every frame kept, not just the first matching one. **That distinction is the
 * whole point of T014**: chapter 3.18 already asserts both of a user's sockets
 * receive a message, using a `waitFor` that resolves on the first match — so a
 * DUPLICATE passes it unnoticed. Story 3 scenario 1 says "both receive it, and
 * each receives it once", and only a count can say the second half. */
function record(socket: WebSocket): Recorded {
  const frames: Recorded["frames"] = [];
  socket.on("message", (raw) => {
    frames.push(JSON.parse(String(raw)) as Recorded["frames"][number]);
  });
  return { socket, frames };
}

async function untilAcked(r: Recorded): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (r.frames.some((f) => f.type === "connection.ack")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no connection.ack within 5s");
}

/** Polls rather than waits on a single frame. A connection is acked before its
 * SUBSCRIBE has necessarily landed, which cost chapter 3.21 a flake at 315 ms —
 * the fix there was polling helpers, not a re-run. */
async function untilCount(
  r: Recorded,
  type: string,
  atLeast: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (r.frames.filter((f) => f.type === type).length >= atLeast) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `only ${r.frames.filter((f) => f.type === type).length} ${type} within 5s`,
  );
}

const count = (r: Recorded, type: string): number =>
  r.frames.filter((f) => f.type === type).length;

describe("every connection a person holds is a first-class recipient (US3)", () => {
  const open: Instance[] = [];
  const sockets: WebSocket[] = [];

  /** A FRESH USER PER TEST, and the first version of this file had one per FILE.
   * Slot keys are `conn:{env}:{user}:{slot}`, so tests sharing a user share five
   * places — and the cap tests fill all five. Two of them failed at 5 s with the
   * previous test's slots still held, because a release is fire-and-forget from a
   * close handler and the registry client had already been quit inside the test
   * body. Per-test users make the leak impossible; the instance owning its own
   * module, closed after `sessions.close()`, makes the release possible. */
  let user: string;

  const connect = (instance: Instance): Recorded => {
    const socket = new WebSocket(`${instance.url}?token=any`);
    sockets.push(socket);
    return record(socket);
  };

  beforeEach(() => {
    user = `u-${randomUUID()}`;
  });

  afterEach(async () => {
    // Sockets before servers. `afterEach` runs in reverse registration order and
    // a teardown that closed servers first cost chapter 3.20 seven tests and
    // eighty-three seconds, every failure naming a hook.
    for (const socket of sockets.splice(0)) socket.close();
    // A beat for each close handler to run its release before the client goes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const instance of open.splice(0)) await instance.close();
  });

  it("accepts five and refuses the sixth with 4004 (FR-001 (3.22), FR-003, SC-002)", async () => {
    const channel = randomUUID();
    const instance = await boot({ user, channels: [channel], cap: {} });
    open.push(instance);

    const five: Recorded[] = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      const r = connect(instance);
      await untilAcked(r);
      five.push(r);
    }
    expect(five).toHaveLength(5);

    // THE CLOSE CODE AND THE ERROR CODE, NOT THE FACT OF CLOSING. A socket that
    // closes for the wrong reason is identical from outside, which is what
    // `contracts/refusal.md` is about — every reuse of the five existing codes
    // sends a client to the wrong remedy.
    const sixth = connect(instance);
    const code = await new Promise<number>((resolve) => {
      sixth.socket.on("close", (c) => resolve(c));
    });
    expect(code).toBe(4004);
    const error = sixth.frames.find((f) => f.type === "error");
    expect(error?.payload["code"]).toBe("connection_limit_reached");
    expect(String(error?.payload["message"])).toContain("close one and reconnect");

    // FR-005 and SC-012: the five are undisturbed. A message published now
    // reaches all of them — the refusal cost them nothing.
    const fanout = createFanout({ url: REDIS, logger: silent });
    await fanout.publish({
      id: randomUUID(),
      channel,
      seq: 3,
      user,
      text: `after the refusal ${randomUUID()}`,
      created_at: new Date(0).toISOString(),
    });
    for (const [i, r] of five.entries()) {
      await untilCount(r, "message.created", 1);
      expect(count(r, "message.created"), `on ${String(i)}`).toBe(1);
    }
    await fanout.close();
  }, 40_000);

  it("frees a slot on close, reusable with NO waiting period (FR-010 (3.22), SC-003)", async () => {
    const channel = randomUUID();
    const instance = await boot({ user, channels: [channel], cap: {} });
    open.push(instance);

    const five: Recorded[] = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      const r = connect(instance);
      await untilAcked(r);
      five.push(r);
    }
    // Close one and take its place. **No clock is involved** — that is the
    // observable difference between this refusal and a rate limit, whose remedy
    // is to wait.
    five[0]?.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const replacement = connect(instance);
    await untilAcked(replacement);
    expect(count(replacement, "connection.ack")).toBe(1);
  }, 40_000);

  it("logs the refusal with the user, the environment and the count, and no credential (FR-015 (3.22), SC-008)", async () => {
    const channel = randomUUID();
    const lines: Record<string, unknown>[] = [];
    const instance = await boot({ user, channels: [channel], cap: {}, lines });
    open.push(instance);

    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      await untilAcked(connect(instance));
    }
    const sixth = connect(instance);
    await new Promise<number>((resolve) => {
      sixth.socket.on("close", (c) => resolve(c));
    });

    const rejected = lines.find(
      (l) => l["msg"] === "connection.rejected" && l["reason"] === "connection_limit_reached",
    );
    expect(rejected, "connection.rejected was not logged").toBeTruthy();
    expect(rejected?.["user"]).toBe(user);
    expect(rejected?.["environment_id"]).toBe(ENVIRONMENT);
    expect(rejected?.["held"]).toBe(5);
    // NFR-SEC-06. "the key rk_dev_abc… is invalid" is how a live secret reaches a
    // support ticket, so the whole line is checked rather than one field.
    expect(JSON.stringify(rejected)).not.toContain("token");
    expect(JSON.stringify(rejected)).not.toContain("rk_");
  }, 40_000);

  it("delivers a message to both of one user's connections, each exactly once (FR-014 (3.22), SC-001)", async () => {
    const channel = randomUUID();
    const instance = await boot({ user, channels: [channel] });
    open.push(instance);

    const a = connect(instance);
    const b = connect(instance);
    await untilAcked(a);
    await untilAcked(b);

    const fanout = createFanout({ url: REDIS, logger: silent });
    const text = `to both tabs ${randomUUID()}`;
    await fanout.publish({
      id: randomUUID(),
      channel,
      seq: 1,
      user,
      text,
      created_at: new Date(0).toISOString(),
    });

    await untilCount(a, "message.created", 1);
    await untilCount(b, "message.created", 1);
    // Settle, so a duplicate has time to arrive and be counted. Asserting a
    // count immediately after the first arrival cannot see a second.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(count(a, "message.created"), "on a").toBe(1);
    expect(count(b, "message.created"), "on b").toBe(1);
    expect(
      (a.frames.find((f) => f.type === "message.created")?.payload as { text: string })
        .text,
    ).toBe(text);
    await fanout.close();
  }, 30_000);

  it("delivers a membership change to both of one user's connections (FR-014 (3.22))", async () => {
    const channel = randomUUID();
    const instance = await boot({ user, channels: [channel] });
    open.push(instance);

    const a = connect(instance);
    const b = connect(instance);
    await untilAcked(a);
    await untilAcked(b);

    // The membership fabric, not the message one. `deliverPresence` is
    // deliberately UNFILTERED and typing's rule is the opposite, and the two sit
    // adjacent in `session.ts` — so a test copied from one to the other asserts
    // the wrong thing. This asserts arrival on both, which is FR-014's subject.
    //
    // PUBLISHED RAW, because the `Membership` module has no `publish`: the api
    // publishes a change and the gateway only ever subscribes. `membership.itest.ts`
    // reached for a raw client for the same reason, and counting a publish through
    // the code that publishes is the shape chapter 3.18 warned about anyway.
    const publisher = new Redis(REDIS);
    await publisher.publish(
      subjectForChannelMembership(channel),
      JSON.stringify({
        environment: ENVIRONMENT,
        channel,
        user,
        change: "added",
      }),
    );

    await untilCount(a, "membership.changed", 1);
    await untilCount(b, "membership.changed", 1);
    await publisher.quit();
  }, 30_000);

  it("keeps delivering to a live connection when an EARLIER one is gone (FR-014 (3.22))", async () => {
    const channel = randomUUID();
    const instance = await boot({ user, channels: [channel] });
    open.push(instance);

    const a = connect(instance);
    const b = connect(instance);
    await untilAcked(a);
    await untilAcked(b);

    // THE FIRST CONNECTION IS THE ONE TERMINATED, and the order is the test.
    // `subscribersOf` returns `[...byId.values()]` — a `Map`, so insertion order —
    // so `a` is delivered to first. Terminating `b` instead would leave a
    // delivery loop that dies on its first failure looking correct, because it
    // would already have reached `a`. **A test that passes whichever way the
    // subject behaves proves nothing**, and the first draft of this test
    // terminated `b`.
    //
    // AND FR-014's SECOND HALF IS NOT WHAT THIS TESTS, because it could not be
    // falsified. The clause says one connection's delivery failure must not
    // prevent another's. `send` is a bare `socket.send(...)` with no try/catch,
    // so the falsification is to make it throw on a socket that is not OPEN —
    // and that leaves all three tests green, because `registry.remove` runs from
    // the terminated socket's own close handler before any publish arrives.
    // **There is no failing send to survive**: a dead connection is gone from
    // the registry, not present-and-broken.
    //
    // So the property is real and unobservable through this fixture, which is
    // chapter 3.20's lesson in its own words — a claim about an observable
    // difference needs falsifying before the test is written. What this test does
    // assert is narrower and still worth having: a surviving connection keeps
    // receiving after an earlier one is gone.
    a.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const fanout = createFanout({ url: REDIS, logger: silent });
    await fanout.publish({
      id: randomUUID(),
      channel,
      seq: 2,
      user,
      text: `after b is gone ${randomUUID()}`,
      created_at: new Date(0).toISOString(),
    });

    await untilCount(b, "message.created", 1);
    expect(count(b, "message.created")).toBe(1);
    await fanout.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// PHASE 6 — US2: the count survives the gateway it was counted on.
//
// Two of the three halves `docs/05-sad.md` gets wrong about `conn:{env}:{user}`.
// Line 167 describes it in the present tense as an instance-id lookup that does
// not exist; line 574 calls the same key "Not built". What is actually needed is
// neither: a count that no single gateway owns, so CON-02's "no sticky routing for
// correctness" survives contact with a cap.
// ---------------------------------------------------------------------------

describe("the count survives the gateway it was counted on (US2)", () => {
  const open: Instance[] = [];
  const sockets: WebSocket[] = [];
  let user: string;

  const connect = (instance: Instance): Recorded => {
    const socket = new WebSocket(`${instance.url}?token=any`);
    sockets.push(socket);
    return record(socket);
  };

  /** **BOUNDED, and for the reason `refusedOn` polls.** An unbounded wait on a
   * close turns an implementation that keeps the connection into a test that hangs
   * until its own timeout — measured at 40,172 ms on the falsification below,
   * against a lane with eleven seconds of headroom. */
  const untilClosed = async (r: Recorded): Promise<number> => {
    const deadline = Date.now() + 5_000;
    let closed: number | undefined;
    r.socket.on("close", (code) => {
      closed = code;
    });
    while (Date.now() < deadline) {
      if (closed !== undefined) return closed;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the socket was still open after 5s");
  };

  /** Connect and expect the door to be shut, returning both codes. The close code
   * AND the error code, never the fact of closing: a socket that closes for the
   * wrong reason is identical from outside, which is the whole subject of
   * `contracts/refusal.md`.
   *
   * **THE ACK IS RACED AGAINST THE CLOSE**, and that is a falsification's finding
   * rather than a nicety. Waiting only for a close means an implementation that
   * ADMITS the connection hangs until the test's own timeout — measured at 40,192
   * ms against a per-instance count, one red test costing forty seconds of a lane
   * with eleven seconds of headroom. Racing them turns the same defect into a
   * one-line diff in about thirty milliseconds. */
  const refusedOn = async (
    instance: Instance,
  ): Promise<{ code: number; error: string | undefined }> => {
    const r = connect(instance);
    // POLLED RATHER THAN `Promise.race`d. `untilAcked` rejects at its own deadline,
    // and a rejection nobody is waiting on any more is an unhandled rejection —
    // which in this package takes the process down.
    let closed: number | undefined;
    r.socket.on("close", (code) => {
      closed = code;
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (closed !== undefined) {
        const frame = r.frames.find((f) => f.type === "error");
        return { code: closed, error: frame?.payload["code"] as string | undefined };
      }
      if (r.frames.some((f) => f.type === "connection.ack")) {
        return { code: -1, error: "accepted" };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("neither refused nor acked within 5s");
  };

  const fill = async (instance: Instance, howMany: number): Promise<Recorded[]> => {
    const held: Recorded[] = [];
    for (let i = 0; i < howMany; i += 1) {
      const r = connect(instance);
      await untilAcked(r);
      held.push(r);
    }
    return held;
  };

  const slotKey = (slot: number, environment = ENVIRONMENT): string =>
    `conn:${environment}:${user}:${String(slot)}`;

  beforeEach(() => {
    user = `u-${randomUUID()}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const instance of open.splice(0)) await instance.close();
  });

  it("counts five across two instances and refuses the sixth on either (FR-006 (3.22), SC-004)", async () => {
    // CON-02 AS A TEST. Two gateways, two registry modules, one Redis, and a cap
    // that neither instance can compute on its own: three places on A and two on
    // B is five, and the sixth has nowhere to go whichever door it knocks on.
    // A per-instance count would accept five more on each.
    const channel = randomUUID();
    const a = await boot({ user, channels: [channel], cap: {} });
    const b = await boot({ user, channels: [channel], cap: {} });
    open.push(a, b);

    await fill(a, 3);
    await fill(b, 2);

    // ON EITHER, and both halves are asserted. A test that only tries the
    // instance holding three would pass against a cap that counts per instance
    // and happens to be full there.
    expect(await refusedOn(a)).toEqual({
      code: 4004,
      error: "connection_limit_reached",
    });
    expect(await refusedOn(b)).toEqual({
      code: 4004,
      error: "connection_limit_reached",
    });
  }, 40_000);

  it("frees a dead instance's slots after the bound (FR-007 (3.22), SC-005)", async () => {
    // AN INJECTED BOUND, the way `presence.itest.ts` injects `graceMs`. The
    // wall-clock version — sixty seconds of waiting — belongs in `quickstart.md`,
    // and it is what proves this injected one is telling the truth.
    const channel = randomUUID();
    const dying = await boot({
      user,
      channels: [channel],
      cap: { boundMs: 1_000, heartbeatMs: 300 },
    });
    open.push(dying);
    await fill(dying, MAX_CONNECTIONS_PER_USER);

    await dying.crash();
    const survivor = await boot({
      user,
      channels: [channel],
      cap: { boundMs: 1_000, heartbeatMs: 300 },
    });
    open.push(survivor);

    // The last renewal landed at most 300 ms before the crash, so the five keys
    // are gone by 1,000 ms after it and no later.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const replacement = connect(survivor);
    await untilAcked(replacement);
    expect(count(replacement, "connection.ack")).toBe(1);
  }, 40_000);

  it("still refuses BEFORE the bound elapses (FR-007 (3.22), SC-005)", async () => {
    // **THE HALF USUALLY SKIPPED**, and the two halves were measured to be
    // independent rather than assumed to be. Dropping the `PX` from the claim
    // turns the test above red and this one green; making the `PX` 1 ms turns this
    // one red and the test above green. So this is the assertion that says the
    // places are really held, and that one says the holding really ends.
    //
    // The first draft of this comment said a slot-frees-eventually test "passes
    // against an implementation whose keys carry no TTL", which is backwards: with
    // no TTL it is the freeing that fails. What this test catches is a cap that
    // claims nothing.
    const channel = randomUUID();
    const dying = await boot({
      user,
      channels: [channel],
      cap: { boundMs: 1_000, heartbeatMs: 300 },
    });
    open.push(dying);
    await fill(dying, MAX_CONNECTIONS_PER_USER);

    await dying.crash();
    const survivor = await boot({
      user,
      channels: [channel],
      cap: { boundMs: 1_000, heartbeatMs: 300 },
    });
    open.push(survivor);

    // 200 ms in, with expiry no earlier than 700 ms.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await refusedOn(survivor)).toEqual({
      code: 4004,
      error: "connection_limit_reached",
    });
  }, 40_000);

  it("frees the slots IMMEDIATELY on a clean shutdown (FR-011a (3.22), SC-013)", async () => {
    // FOUND BY BUILDING `traceability.md` DURING PLANNING: one task wrote
    // `releaseAll()`, another asserted `connections.close()` was *registered* in
    // `main.ts`, and nothing asserted anything was released. The crash test above
    // covers the opposite path.
    //
    // THE DEFAULT BOUND IS THE POINT. Sixty seconds, and this test finishes in
    // about one — so expiry cannot explain the acceptance, and neither can a
    // socket's own close handler, because the sockets are still open. The default
    // twenty-second heartbeat matters too: a short one would have a renewal
    // re-claim the places straight after `releaseAll()` freed them.
    const channel = randomUUID();
    const replaced = await boot({ user, channels: [channel], cap: {} });
    open.push(replaced);
    await fill(replaced, MAX_CONNECTIONS_PER_USER);

    const successor = await boot({ user, channels: [channel], cap: {} });
    open.push(successor);
    // NFR-REL-03 allows a deployment no more than one reconnection cycle, and a
    // bound's worth of refusals after every deploy is more than one.
    expect(await refusedOn(successor)).toEqual({
      code: 4004,
      error: "connection_limit_reached",
    });

    await replaced.shutdown();
    const reconnected = connect(successor);
    await untilAcked(reconnected);
    expect(count(reconnected, "connection.ack")).toBe(1);
  }, 40_000);

  it("keeps a heartbeating connection's slot across three bounds (FR-008 (3.22), SC-006)", async () => {
    // CHAPTER 3.19 SHIPPED A PRESENCE BUG BY ARMING A CHECK AT EXACTLY ITS OWN
    // GRACE PERIOD — two deadlines on one instant, reached by two clocks, and the
    // losing side stranded a user online for ever. This is the test that would
    // have caught the same mistake here: three renewals per bound, so two
    // consecutive misses still do not free a live connection's place.
    const channel = randomUUID();
    const lines: Record<string, unknown>[] = [];
    const instance = await boot({
      user,
      channels: [channel],
      cap: { boundMs: 600, heartbeatMs: 200 },
      lines,
    });
    open.push(instance);

    const live = await fill(instance, 1);
    const before = await raw.get(slotKey(0));
    expect(before, "the connection did not claim slot 0").toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // THE SAME VALUE IN THE SAME KEY, three bounds later. Non-null alone would be
    // satisfied by a slot the connection lost and then re-claimed, which is a
    // different outcome — so the log is checked for the re-claim as well.
    expect(await raw.get(slotKey(0))).toBe(before);
    expect(live[0]?.socket.readyState).toBe(WebSocket.OPEN);
    expect(lines.filter((l) => l["msg"] === "connection.reclaimed")).toEqual([]);
    expect(lines.filter((l) => l["msg"] === "connection.rejected")).toEqual([]);
  }, 40_000);

  it("counts each environment separately for one user (FR-012 (3.22))", async () => {
    // CONSTITUTION I. The key carries the environment, so the same person in a
    // customer's staging and production environments has two allowances rather
    // than one shared between them.
    const channel = randomUUID();
    const other = `env-${randomUUID()}`;
    const here = await boot({ user, channels: [channel], cap: {} });
    const there = await boot({
      user,
      channels: [channel],
      environment: other,
      cap: {},
    });
    open.push(here, there);

    await fill(here, MAX_CONNECTIONS_PER_USER);
    // Accepted in the other environment while this one is full.
    const across = connect(there);
    await untilAcked(across);
    expect(count(across, "connection.ack")).toBe(1);
    // AND THE FIRST ENVIRONMENT REALLY WAS FULL, which is the half that makes the
    // acceptance above mean something. Without it the test passes against a cap
    // that counts nothing.
    expect(await refusedOn(here)).toEqual({
      code: 4004,
      error: "connection_limit_reached",
    });
  }, 40_000);

  it("does not resurrect an expired slot on renewal (FR-011 (3.22))", async () => {
    // THE KEY IS DELETED RATHER THAN WAITED OUT, so the state is exact and no
    // sleep is being trusted to be longer than a TTL.
    //
    // THE LOG LINE IS THE DISCRIMINATOR, and there is no other. Under `IFEQ` the
    // renewal is refused and the module re-claims — `connection.reclaimed`. Under a
    // plain `SET` the renewal succeeds against a key that does not exist, the slot
    // is resurrected, and no line appears. The end state of the two is the same
    // key holding the same id, which is why this test reads the logs.
    const channel = randomUUID();
    const lines: Record<string, unknown>[] = [];
    const instance = await boot({
      user,
      channels: [channel],
      cap: { heartbeatMs: 200 },
      lines,
    });
    open.push(instance);
    await fill(instance, 1);
    expect(await raw.get(slotKey(0))).toBeTruthy();

    await raw.del(slotKey(0));
    await new Promise((resolve) => setTimeout(resolve, 500));

    const reclaimed = lines.filter((l) => l["msg"] === "connection.reclaimed");
    expect(reclaimed, "the renewal was not refused").toHaveLength(1);
    expect(reclaimed[0]?.["slot"]).toBe(0);
  }, 40_000);

  it("refuses to renew a slot another connection took, rather than overwriting it (FR-011 (3.22))", async () => {
    // A DIFFERENT STATE FROM THE TEST ABOVE, and the one FR-011's second sentence
    // was written for: the slot did not just expire, somebody else has it.
    //
    // `XX` TESTS EXISTENCE AND NOT OWNERSHIP — measured on Redis 8.10.0, `SET k B
    // XX` against a key holding `A` returns OK — so under `XX` this renewal would
    // take the rival's place back and six connections would be open against a
    // count of five. The test above stays green under `XX`, because `XX` also
    // refuses a key that is absent.
    //
    // T056's task text called this "the only test in the chapter that catches that
    // substitution" and the falsification says otherwise: `IFEQ` → `XX` turns this
    // test AND the cap-really-full test below red, two of sixteen. The claim was
    // inherited from the task list and not re-run — this chapter's most common
    // finding, one level up.
    //
    // PLANTED WITH ONE COMMAND rather than a delete followed by a claim. The two-
    // command version has a window: a renewal firing inside it re-claims slot 0
    // legitimately, the rival lands on slot 1, and the assertion below fails for a
    // reason that is not a defect.
    const channel = randomUUID();
    const lines: Record<string, unknown>[] = [];
    const instance = await boot({
      user,
      channels: [channel],
      cap: { heartbeatMs: 200 },
      lines,
    });
    open.push(instance);
    await fill(instance, 1);

    const rival = randomUUID();
    await raw.set(slotKey(0), rival, "PX", 60_000);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Still the rival's. The renewal was refused and the connection went and found
    // slot 1 instead.
    expect(await raw.get(slotKey(0))).toBe(rival);
    const reclaimed = lines.filter((l) => l["msg"] === "connection.reclaimed");
    expect(reclaimed, "the renewal was not refused").toHaveLength(1);
    expect(reclaimed[0]?.["slot"]).toBe(1);
    expect(await raw.get(slotKey(1))).toBeTruthy();
  }, 40_000);

  it("keeps the connection working on a NEW slot after a re-claim (FR-011b (3.22), SC-014)", async () => {
    // THE BRANCH A DESIGN THAT CLOSES ON ANY REFUSED RENEWAL GETS WRONG, and the
    // one that happens after every brief outage: the slot expired, nothing else
    // took it, and the user is under the limit. Closing here would cost somebody
    // their connection for the registry's downtime.
    //
    // THE ASSERTION IS DELIVERY, not the log line the two tests above read. A
    // socket can be open and no longer subscribed to anything.
    const channel = randomUUID();
    const lines: Record<string, unknown>[] = [];
    const instance = await boot({
      user,
      channels: [channel],
      cap: { heartbeatMs: 200 },
      lines,
    });
    open.push(instance);
    const [live] = await fill(instance, 1);
    if (live === undefined) throw new Error("expected a connection");

    await raw.del(slotKey(0));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(lines.filter((l) => l["msg"] === "connection.reclaimed")).toHaveLength(1);

    const fanout = createFanout({ url: REDIS, logger: silent });
    await fanout.publish({
      id: randomUUID(),
      channel,
      seq: 4,
      user,
      text: `after the re-claim ${randomUUID()}`,
      created_at: new Date(0).toISOString(),
    });
    await untilCount(live, "message.created", 1);
    expect(live.socket.readyState).toBe(WebSocket.OPEN);
    expect(live.frames.filter((f) => f.type === "error")).toEqual([]);
    await fanout.close();
  }, 40_000);

  it("closes the connection when the cap is genuinely full at renewal (FR-011b (3.22), SC-014)", async () => {
    // THE OTHER BRANCH, and it has to close: the place is gone, all five are held
    // by other connections, and leaving this one open is six against a count of
    // five. FR-005 is not in tension with this — it governs a REFUSAL, where
    // opening a sixth must not cost the five. Here the connection has already lost
    // its place to a competitor.
    //
    // The same code and the same message a refused sixth connection gets, because
    // that is what it means.
    const channel = randomUUID();
    const lines: Record<string, unknown>[] = [];
    const instance = await boot({
      user,
      channels: [channel],
      cap: { heartbeatMs: 200 },
      lines,
    });
    open.push(instance);
    const [live] = await fill(instance, 1);
    if (live === undefined) throw new Error("expected a connection");

    // Every place taken by somebody else, this connection's included.
    for (let slot = 0; slot < MAX_CONNECTIONS_PER_USER; slot += 1) {
      await raw.set(slotKey(slot), randomUUID(), "PX", 60_000);
    }

    expect(await untilClosed(live)).toBe(4004);
    const error = live.frames.find((f) => f.type === "error");
    expect(error?.payload["code"]).toBe("connection_limit_reached");
    expect(String(error?.payload["message"])).toContain("close one and reconnect");
    const rejected = lines.filter(
      (l) =>
        l["msg"] === "connection.rejected" &&
        l["reason"] === "connection_limit_reached",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.["held"]).toBe(5);
  }, 40_000);
});
