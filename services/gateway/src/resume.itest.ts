import { docsUrl } from "@relay/protocol";
import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createLogger, serve, type Logger } from "@relay/service-kit";
import type { Frame, Message } from "@relay/protocol";

import type { ApiClient } from "./api-client.js";
import { createFanout } from "./fanout.js";
import { attachSessions } from "./session.js";

// Chapter 2.7's race, run against a REAL broker. The unit suite proves the
// ordering with a stub whose timing the test controls; this file proves it
// with Redis in the middle, where the publish is a network round trip on
// another connection and nobody is faking the interleaving.
//
// The api is still a stub — the gateway has no database (ADR-05), and the
// api's own half of resume is tested in its own lane against Postgres. What
// is real here is the thing that was fake before: the fabric.
//
//   docker compose up -d redis
//   RELAY_REDIS_PORT=16379 pnpm --filter @relay/gateway test:integration

const url = `redis://localhost:${process.env.RELAY_REDIS_PORT ?? "6379"}`;
const silent: Logger = createLogger("gateway", () => {});
// Unique per run, so this suite and 2.6's cannot hear each other on a
// shared broker (see the note in fanout.itest.ts).
const CHANNEL = randomUUID();

function frame(seq: number): Message {
  return {
    id: `id-${seq}`,
    channel: CHANNEL,
    seq,
    user: "dispatcher",
    text: `m${seq}`,
    created_at: "2026-08-04T00:00:00.000Z",
  };
}

const VALID_TOKEN = "token-for-tuan";

/** Chapter 3.2: the gateway holds no signing secret, so a test token is an
 * opaque string the stubbed api agrees to recognise. What this suite proves —
 * the resume race against a real broker — never depended on the signature. */
function token(): Promise<string> {
  return Promise.resolve(VALID_TOKEN);
}


interface Harness {
  url: string;
  close: () => Promise<void>;
}

/** Chapter 3.11 widened `ApiClient` with `reportUsage`, and every stub in this
 * file is about resume rather than metering — so the method is supplied here
 * once instead of six times, and the `Omit` says which half these tests speak
 * to. */
async function boot(api: Omit<ApiClient, "reportUsage">): Promise<Harness> {
  const fanout = createFanout({ url, logger: silent });
  const server: Server = serve({
    service: "gateway",
    health: () => ({}),
    logger: silent,
    notFoundDocsUrl: docsUrl("not_found"),
  });
  const sessions = attachSessions({
    server,
    api: { ...api, reportUsage: async () => null },
    logger: silent,
    fanout,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/v1/ws`,
    close: async () => {
      await sessions.close();
      await fanout.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Another gateway instance, as far as Redis is concerned. */
async function publishFromElsewhere(message: Message): Promise<void> {
  const other = createFanout({ url, logger: silent });
  await other.publish(message);
  await other.close();
}

function record(socket: WebSocket): Frame[] {
  const frames: Frame[] = [];
  socket.on("message", (raw) =>
    frames.push(JSON.parse(raw.toString()) as Frame),
  );
  return frames;
}

const created = (frames: Frame[]): number[] =>
  frames
    .filter((f) => f.type === "message.created")
    .map((f) => (f as { payload: Message }).payload.seq);

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("resume across a real fabric", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("loses nothing and repeats nothing when a frame is published mid-backfill", async () => {
    // The backfill leg is deliberately slow, and a DIFFERENT process — a
    // different fanout client on the same subject — publishes into the
    // window. Neither side coordinates; only the buffer saves this.
    harness = await boot({
      session: async () => ({
        environment_id: "env-1",
        user: "tuan",
        // Chapter 3.15: the api now reports whether the user is banned, and a stub
        // that does not say is a stub that has not thought about it.
        banned: false,
        channel_ids: [CHANNEL],
        // Chapter 3.8: the limits ride the session response now. Generous, and
        // beside the point of every test in this file.
        limits: { connect: 3_000, send: 600 },
      }),
      backfill: async () => {
        await publishFromElsewhere(frame(43));
        await settle(150); // give Redis time to actually deliver it
        return {
          [CHANNEL]: { messages: [frame(42), frame(43)], truncated: false },
        };
      },
      sendMessage: async () => {
        throw new Error("not used");
      },
    });
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await settle(700);
    const seqs = created(frames);
    expect(seqs).toEqual([42, 43]);
    expect(new Set(seqs).size).toBe(seqs.length);
    socket.close();
  });

  it("delivers a mid-backfill frame that the backfill did not contain", async () => {
    // Committed after the backfill's snapshot: it exists ONLY in the buffer,
    // and the flush is the only reason the client ever sees it.
    harness = await boot({
      session: async () => ({
        environment_id: "env-1",
        user: "tuan",
        // Chapter 3.15: the api now reports whether the user is banned, and a stub
        // that does not say is a stub that has not thought about it.
        banned: false,
        channel_ids: [CHANNEL],
        // Chapter 3.8: the limits ride the session response now. Generous, and
        // beside the point of every test in this file.
        limits: { connect: 3_000, send: 600 },
      }),
      backfill: async () => {
        await publishFromElsewhere(frame(43));
        await settle(150);
        return { [CHANNEL]: { messages: [frame(42)], truncated: false } };
      },
      sendMessage: async () => {
        throw new Error("not used");
      },
    });
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await settle(700);
    expect(created(frames)).toEqual([42, 43]);
    socket.close();
  });

  it("goes live after the flush, with no buffering left behind", async () => {
    harness = await boot({
      session: async () => ({
        environment_id: "env-1",
        user: "tuan",
        // Chapter 3.15: the api now reports whether the user is banned, and a stub
        // that does not say is a stub that has not thought about it.
        banned: false,
        channel_ids: [CHANNEL],
        // Chapter 3.8: the limits ride the session response now. Generous, and
        // beside the point of every test in this file.
        limits: { connect: 3_000, send: 600 },
      }),
      backfill: async () => ({
        [CHANNEL]: { messages: [frame(42)], truncated: false },
      }),
      sendMessage: async () => {
        throw new Error("not used");
      },
    });
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await settle(400);
    // A frame published AFTER the resume finished must arrive immediately —
    // the phase went back to normal 2.6 delivery.
    await publishFromElsewhere(frame(44));
    await settle(300);
    expect(created(frames)).toEqual([42, 44]);
    socket.close();
  });

  it("suppresses a frame the backfill already delivered, published after the resume", async () => {
    // THE FOURTH QUADRANT, and the defect this chapter exists to close.
    //
    // The three tests above cover: published while buffering and in the backfill
    // (deduplicated by `flushable`); published while buffering and NOT in the
    // backfill (delivered by the flush); published after going live with a
    // sequence ABOVE the mark (delivered). The cell they leave empty is this one —
    // published after going live, with a sequence the backfill already sent.
    //
    // It is not a contrived case. A message is durable at one instant and
    // announced at another: the gateway commits through the api and only then
    // publishes to Redis. A backfill query landing between those two instants
    // returns a message the fabric has not yet delivered, and the delivery arrives
    // after the resume has finished — when chapter 2.7's dedup window has already
    // closed, because `marks` was a local variable that `resume()` discarded.
    //
    // One number different from the test above it. That is the whole bug.
    harness = await boot({
      session: async () => ({
        environment_id: "env-1",
        user: "tuan",
        // Chapter 3.15: the api now reports whether the user is banned, and a stub
        // that does not say is a stub that has not thought about it.
        banned: false,
        channel_ids: [CHANNEL],
        // Chapter 3.8: the limits ride the session response now. Generous, and
        // beside the point of every test in this file.
        limits: { connect: 3_000, send: 600 },
      }),
      backfill: async () => ({
        [CHANNEL]: { messages: [frame(42)], truncated: false },
      }),
      sendMessage: async () => {
        throw new Error("not used");
      },
    });
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await settle(400);
    // The resume has completed. NOW the fabric catches up with a message the
    // backfill already delivered — the publish that was still in flight while the
    // backfill query ran.
    await publishFromElsewhere(frame(42));
    await settle(300);

    expect(created(frames)).toEqual([42]);
    socket.close();
  });

  it("still suppresses when two instances publish out of order", async () => {
    // Sequences COMMIT in order under a channel row lock; they are PUBLISHED by
    // whichever gateway instance handled each send, and those do not coordinate.
    // A prompt publish of 43 can precede a stalled publish of 42.
    //
    // This is the case that made the spec's first design unsafe. It proposed
    // retiring the mark once a higher sequence arrived — which would see the 43,
    // drop the mark, and then deliver the 42 (research R3).
    harness = await boot({
      session: async () => ({
        environment_id: "env-1",
        user: "tuan",
        // Chapter 3.15: the api now reports whether the user is banned, and a stub
        // that does not say is a stub that has not thought about it.
        banned: false,
        channel_ids: [CHANNEL],
        // Chapter 3.8: the limits ride the session response now. Generous, and
        // beside the point of every test in this file.
        limits: { connect: 3_000, send: 600 },
      }),
      backfill: async () => ({
        [CHANNEL]: { messages: [frame(42)], truncated: false },
      }),
      sendMessage: async () => {
        throw new Error("not used");
      },
    });
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await settle(400);
    // 43 is ABOVE the mark and must be delivered. A rule that retired the mark on
    // seeing it would then have nothing left to compare the delayed 42 against.
    await publishFromElsewhere(frame(43));
    await settle(150);
    // 42 is the mark itself, arriving late from an instance that stalled between
    // its api call and its publish. It must still be suppressed.
    await publishFromElsewhere(frame(42));
    await settle(300);

    expect(created(frames)).toEqual([42, 43]);
    socket.close();
  });

  it("suppresses nothing when the resume degraded", async () => {
    // A degraded resume tells the client to page history for every channel, so the
    // backfill it received is a fragment or nothing at all. A mark taken from it
    // would suppress messages the client never got — turning this chapter's
    // duplicate into a gap, which constitution II ranks worse.
    harness = await boot({
      session: async () => ({
        environment_id: "env-1",
        user: "tuan",
        // Chapter 3.15: the api now reports whether the user is banned, and a stub
        // that does not say is a stub that has not thought about it.
        banned: false,
        channel_ids: [CHANNEL],
        // Chapter 3.8: the limits ride the session response now. Generous, and
        // beside the point of every test in this file.
        limits: { connect: 3_000, send: 600 },
      }),
      backfill: async () => {
        throw new Error("backfill unavailable");
      },
      sendMessage: async () => {
        throw new Error("not used");
      },
    });
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await settle(400);
    // A sequence at or below the presented cursor. With no mark retained it must
    // still arrive: the client was told to page history, not to expect silence.
    await publishFromElsewhere(frame(41));
    await settle(300);

    expect(created(frames)).toEqual([41]);
    socket.close();
  });
});

// ── chapter 3.18: two instances, one fabric (US2) ───────────────────────────
//
// `boot()` IS UNTOUCHED. It is called six times above and each call builds its
// own `createFanout` and its own server, so two calls already give two gateway
// instances sharing one Redis — which is precisely what SC-002 needs. Changing
// the fixture to "support" that would have changed six passing tests to prove
// nothing new (3.17's T040b, the fifth such incident in two features).
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. The api here is a stub, as everywhere
// in this file: the gateway has no database (ADR-05) and these suites are about
// the fabric. So this is the DELIVERY half of SC-002 — a frame published by
// somebody else reaches the instance holding a member and only that one. The
// half where a REAL api publishes lives in `session.itest.ts`, which spawns one.
// Neither fixture does both, and `chapter-notes.md` says so rather than letting
// the pair imply it.
describe("two instances on one fabric (chapter 3.18)", () => {
  const OTHER_CHANNEL = randomUUID();
  let member: Harness | undefined;
  let bystander: Harness | undefined;
  /** Closed BEFORE the harnesses. `Harness.close()` calls `server.close()`,
   * which waits for open connections to drain — so a test that leaves a socket
   * open hangs the teardown, and vitest reports it as "Hook timed out in
   * 10000ms" pointing at `afterEach`. The first version of these tests looked
   * like a delivery failure and was a housekeeping one. */
  const sockets: WebSocket[] = [];
  const open = async (harness: Harness) => {
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    sockets.push(socket);
    return record(socket);
  };

  const stub = (channels: string[]) => ({
    session: async () => ({
      environment_id: "env-1",
      user: "tuan",
      banned: false,
      channel_ids: channels,
      limits: { connect: 3_000, send: 600 },
    }),
    backfill: async () => ({}),
    sendMessage: async () => {
      throw new Error("not used");
    },
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await member?.close();
    await bystander?.close();
    member = undefined;
    bystander = undefined;
  });

  it("delivers to the instance holding a member (SC-002)", async () => {
    member = await boot(stub([CHANNEL]));
    const frames = await open(member);
    await settle(200);

    // Published by a THIRD client — neither instance's own — which is what the
    // api is once it publishes. The instance under test is a subscriber only.
    await publishFromElsewhere(frame(3_001));
    await settle(400);

    expect(created(frames)).toEqual([3_001]);
  });

  it("delivers to NEITHER instance for a channel neither holds (SC-002's negative)", async () => {
    // The subject is the filter and it is the only one. An instance subscribes
    // to `chan:{id}` because a session named that channel at connect; a frame on
    // any other subject is not something it declines to deliver, it is something
    // it never hears.
    member = await boot(stub([CHANNEL]));
    bystander = await boot(stub([OTHER_CHANNEL]));
    const a = await open(member);
    const b = await open(bystander);
    await settle(200);

    // A third channel, which neither session named.
    await publishFromElsewhere({ ...frame(3_002), channel: randomUUID() });
    await settle(400);

    expect(created(a)).toEqual([]);
    expect(created(b)).toEqual([]);
  });

  it("delivers to the member's instance and not to the bystander's", async () => {
    // The pair that matters for SC-002: two live instances, one frame, and the
    // silence on the second is as much of the assertion as the arrival on the
    // first. Asserted by COUNT on both sides — "the member got it" alone would
    // be satisfied by a fabric that broadcast to everybody.
    member = await boot(stub([CHANNEL]));
    bystander = await boot(stub([OTHER_CHANNEL]));
    const a = await open(member);
    const b = await open(bystander);
    await settle(200);

    await publishFromElsewhere(frame(3_003));
    await settle(400);

    expect(created(a)).toEqual([3_003]);
    expect(created(b)).toEqual([]);
  });
});
