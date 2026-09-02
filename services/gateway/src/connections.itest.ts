import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { docsUrl, subjectForChannelMembership } from "@relay/protocol";
import { serve } from "@relay/service-kit";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { ApiClient } from "./api-client.js";
import { createFanout } from "./fanout.js";
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

interface Instance {
  url: string;
  close: () => Promise<void>;
}

/** One gateway, in process, with a stubbed api — the shape `resume.itest.ts` and
 * `typing.itest.ts` use. No api is spawned, so this file claims no port range and
 * adds nothing to the seven spawning files in the lane. */
async function boot(options: {
  user: string;
  channels: string[];
}): Promise<Instance> {
  const fanout = createFanout({ url: REDIS, logger: silent });
  const membership = createMembership({ url: REDIS, logger: silent });
  const server: Server = serve({
    service: "gateway",
    health: () => ({}),
    logger: silent,
    notFoundDocsUrl: docsUrl("not_found"),
  });
  const api: ApiClient = {
    session: async () => ({
      environment_id: ENVIRONMENT,
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
  const sessions = attachSessions({
    server,
    api,
    logger: silent,
    fanout,
    membership,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/v1/ws`,
    close: async () => {
      await sessions.close();
      await fanout.close();
      await membership.close();
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

  const connect = (instance: Instance): Recorded => {
    const socket = new WebSocket(`${instance.url}?token=any`);
    sockets.push(socket);
    return record(socket);
  };

  afterEach(async () => {
    // Sockets before servers. `afterEach` runs in reverse registration order and
    // a teardown that closed servers first cost chapter 3.20 seven tests and
    // eighty-three seconds, every failure naming a hook.
    for (const socket of sockets.splice(0)) socket.close();
    for (const instance of open.splice(0)) await instance.close();
  });

  it("delivers a message to both of one user's connections, each exactly once (FR-014 (3.22), SC-001)", async () => {
    const channel = randomUUID();
    const instance = await boot({ user: "tuan", channels: [channel] });
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
      user: "tuan",
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
    const instance = await boot({ user: "tuan", channels: [channel] });
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
        user: "tuan",
        change: "added",
      }),
    );

    await untilCount(a, "membership.changed", 1);
    await untilCount(b, "membership.changed", 1);
    await publisher.quit();
  }, 30_000);

  it("keeps delivering to a live connection when an EARLIER one is gone (FR-014 (3.22))", async () => {
    const channel = randomUUID();
    const instance = await boot({ user: "tuan", channels: [channel] });
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
      user: "tuan",
      text: `after b is gone ${randomUUID()}`,
      created_at: new Date(0).toISOString(),
    });

    await untilCount(b, "message.created", 1);
    expect(count(b, "message.created")).toBe(1);
    await fanout.close();
  }, 30_000);
});
