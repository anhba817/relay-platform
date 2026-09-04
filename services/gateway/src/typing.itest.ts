import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  createServer as createNetServer,
  connect as connectSocket,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";

import {
  docsUrl,
  subjectForChannel,
  subjectForChannelMembership,
  subjectForPresence,
  subjectForTyping,
  subjectForUserMembership,
} from "@relay/protocol";
import { createLogger, serve, type Logger } from "@relay/service-kit";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { ApiClient } from "./api-client.js";
import type { Decision, GatewayLimits } from "./limits.js";
import { createFanout } from "./fanout.js";
import { createMembership, type Membership } from "./membership.js";
import { createPresence } from "./presence.js";
import { attachSessions } from "./session.js";
import { createTyping, type Typing } from "./typing.js";

// Chapter 3.21's fabric, against a REAL Redis.
//
// NO API IS SPAWNED, AND THAT IS THE POINT OF THE FILE'S SHAPE. Seven of the
// gateway's nine integration files spawn their own api, and five of the seven
// failures across chapter 3.20's forty battery runs were one of those fixtures
// failing to come up. `resume.itest.ts` spawns none — it stubs the `ApiClient`
// and boots gateways in process — and typing needs no api either, because it
// writes nothing and reads nothing. **This is a tenth file and the spawn count
// stays at seven.**
//
// AND NO PORT RANGE. `server.listen(0)` lets the OS assign, so two in-process
// instances get two distinct ports for free and this file appears nowhere in the
// lane's port map. The seven files that hold ranges are the seven that spawn an
// api. Chapter 3.20 reached for a fixed range instead and collided twice — once
// taking `isolation.itest.ts`'s exactly, then overlapping it again.
//
//   docker compose up -d redis
//   pnpm --filter @relay/gateway test:integration

const url = `redis://localhost:${process.env.RELAY_REDIS_PORT ?? "6379"}`;
const silent: Logger = createLogger("gateway", () => {});

const VALID_TOKEN = "token-for-tuan";

interface Instance {
  url: string;
  typing: Typing;
  close: () => Promise<void>;
}

/** One gateway, in process, with a real typing fabric and a stubbed api.
 *
 * `channels` is what the stub says this connection may hear — the same list the
 * session layer copies into `connection.channelIds`, which is what
 * `signalTyping` checks a signal against. */
async function boot(options: {
  user: string;
  channels: string[];
  environment?: string;
  /** T050. `createLogger`'s sink receives a JSON **string** with the fields at
   * the top level, not an object — so a test that destructured `fields` would
   * silently assert nothing. Parsed here once, and one known line is asserted
   * before anything relies on the mechanism. */
  lines?: Record<string, unknown>[];
  membership?: Membership;
  limits?: GatewayLimits;
  renewalIntervalMs?: number;
  /** Chapter 3.21 phase 7. **The `ApiClient` is the seam that widens the resume
   * window**, and chapter 3.20 recorded why nothing else does: slowing the FABRIC
   * calls `degrade()`, which empties the buffer itself. A connection is
   * `buffering` only from the upgrade until `api.backfill` returns — about twenty
   * milliseconds on this lane — so a test about mid-resume delivery has to make
   * that call slow. The code path is the real one; only the clock moves. */
  backfillDelayMs?: number;
  backfillFrames?: Record<string, { messages: unknown[]; truncated: boolean }>;
  /** Points this instance's fabric at a proxy instead of Redis, so a test can
   * sever the connection without touching anything shared. */
  redisUrl?: string;
  /** T072 only: the other three fabrics, so one watcher can receive all four
   * kinds over the same channel. */
  allFabrics?: boolean;
}): Promise<Instance> {
  const environment = options.environment ?? "env-1";
  const logger =
    options.lines === undefined
      ? silent
      : createLogger("gateway", (line: string) => {
          options.lines?.push(JSON.parse(line) as Record<string, unknown>);
        });
  const typing = createTyping({ url: options.redisUrl ?? url, logger });
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
    backfill: async () => {
      if (options.backfillDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, options.backfillDelayMs));
      }
      return (options.backfillFrames ?? {}) as never;
    },
    sendMessage: async () => {
      throw new Error("not used");
    },
    reportUsage: async () => null,
  };
  const fanout = options.allFabrics ? createFanout({ url, logger: silent }) : undefined;
  const presence = options.allFabrics
    ? createPresence({ url, logger: silent })
    : undefined;
  const membership =
    options.membership ??
    (options.allFabrics ? createMembership({ url, logger: silent }) : undefined);
  const sessions = attachSessions({
    server,
    api,
    logger,
    typing,
    ...(fanout === undefined ? {} : { fanout }),
    ...(presence === undefined ? {} : { presence }),
    ...(membership === undefined ? {} : { membership }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.renewalIntervalMs === undefined
      ? {}
      : { renewalIntervalMs: options.renewalIntervalMs }),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/v1/ws`,
    typing,
    close: async () => {
      await sessions.close();
      await typing.close();
      await fanout?.close();
      await presence?.close();
      // Only the one this harness built: an injected module belongs to its test.
      if (options.membership === undefined) await membership?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A raw subscriber on the typing subject, which is what a publish assertion has
 * to be made on.
 *
 * NOT THIS CHAPTER'S OWN MODULE. Counting publishes through the code that
 * publishes is the shape chapter 3.18 warned about — a publisher that does
 * nothing satisfies it. `presence.itest.ts` and `membership.itest.ts` both
 * reached for a raw client for the same reason, and both took the
 * `DRIVER_EXEMPT_TESTS` entry this file also takes. */
async function watch(channelId: string): Promise<{
  signals: unknown[];
  close: () => Promise<void>;
}> {
  const subscriber = new Redis(url);
  const signals: unknown[] = [];
  subscriber.on("message", (_subject: string, raw: string) => {
    signals.push(JSON.parse(raw));
  });
  await subscriber.subscribe(subjectForTyping(channelId));
  return {
    signals,
    close: async () => {
      subscriber.disconnect();
    },
  };
}

/** A TCP proxy in front of the real Redis, so a test can sever and restore a
 * connection without touching anything shared.
 *
 * **NEVER `docker compose stop redis`.** These files run in PARALLEL, and
 * `services/api/src/limits/limits.itest.ts:484` already writes the rule down: "a
 * dead port rather than stopping the container, because the lane runs files in
 * PARALLEL and stopping Redis would break every other suite mid-run". A dead port
 * covers "down" and cannot cover "restored", and `redis-server` is not installed
 * on the lane machine, so the proxy is what is left.
 *
 * Copied from `presence.itest.ts` rather than shared. The duplication is the
 * cheaper half of the trade: a helper extracted into a fourth file would be
 * imported by two suites that run in parallel and would then need its own
 * lifetime story. */
async function startRedisProxy(): Promise<{
  url: string;
  cut: () => Promise<void>;
  restore: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const target = new URL(process.env.RELAY_REDIS_URL ?? "redis://localhost:6379");
  const live = new Set<Socket>();
  let server: NetServer | null = null;
  let port = 0;

  const listen = (onPort: number): Promise<number> =>
    new Promise<number>((resolve) => {
      const next = createNetServer((client) => {
        const upstream = connectSocket(
          Number(target.port || 6379),
          target.hostname,
        );
        client.pipe(upstream);
        upstream.pipe(client);
        for (const socket of [client, upstream]) {
          live.add(socket);
          socket.on("error", () => socket.destroy());
          socket.on("close", () => live.delete(socket));
        }
      });
      next.listen(onPort, "127.0.0.1", () => {
        server = next;
        resolve((next.address() as AddressInfo).port);
      });
    });

  port = await listen(0);
  return {
    url: `redis://127.0.0.1:${port}`,
    cut: async () => {
      for (const socket of live) socket.destroy();
      live.clear();
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
      server = null;
    },
    // Re-listening on the SAME port is what "without a restart" means: ioredis
    // reconnects on its own and the module is never rebuilt.
    restore: async () => {
      await listen(port);
    },
    close: async () => {
      for (const socket of live) socket.destroy();
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
    },
  };
}

const settle = (ms = 300): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("a typing signal on its way out (chapter 3.21)", () => {
  const open: Array<() => Promise<void>> = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    // Sockets before servers. `afterEach` runs in reverse registration order and
    // a describe-level teardown that closed servers first cost chapter 3.20
    // seven tests and eighty-three seconds, every failure naming a hook.
    for (const socket of sockets.splice(0)) socket.close();
    for (const close of open.splice(0)) await close();
  });

  const connect = (instance: Instance): WebSocket => {
    const socket = new WebSocket(`${instance.url}?token=${VALID_TOKEN}`);
    sockets.push(socket);
    return socket;
  };

  const acked = (socket: WebSocket): Promise<void> =>
    new Promise((resolve) => {
      socket.on("message", (raw) => {
        if ((JSON.parse(String(raw)) as { type: string }).type === "connection.ack")
          resolve();
      });
    });

  /** T036. A CHANNEL THE CONNECTION DOES NOT HOLD PUBLISHES NOTHING (FR-007).
   *
   * **Asserted on the subscriber, not on the socket.** A silence assertion at the
   * socket cannot tell a filtered publish from a broken publisher: both look like
   * nothing arriving. The subscriber can — it sees the signal for the channel the
   * connection DOES hold, in the same run, so "nothing published" is a claim
   * about the filter rather than about the fabric being asleep.
   *
   * And no error frame: an error would tell a client whether a channel exists,
   * which is the probe chapter 3.15 closed on the REST surface. */
  it("publishes nothing for a channel the connection is not a member of, and says nothing", async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    const instance = await boot({ user: "tuan", channels: [mine] });
    open.push(instance.close);

    const watchMine = await watch(mine);
    const watchTheirs = await watch(theirs);
    open.push(watchMine.close, watchTheirs.close);

    const socket = connect(instance);
    const frames: { type: string }[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await acked(socket);

    socket.send(JSON.stringify({ type: "typing.send", payload: { channel: theirs } }));
    await settle();

    expect(watchTheirs.signals).toEqual([]);
    expect(frames.filter((f) => f.type === "error")).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    // The same connection, the same fabric, a channel it does hold: the publisher
    // works, so the silence above is the filter.
    socket.send(JSON.stringify({ type: "typing.send", payload: { channel: mine } }));
    await settle();
    expect(watchMine.signals).toEqual([
      { environment: "env-1", channel: mine, user: "tuan" },
    ]);
  });

  /** T037's second half: the delivered signal names the CONNECTION's identity.
   *
   * The inbound frame carries no user at all, so this cannot be tested by sending
   * a false one — the schema rejects that, and `session.itest.ts` covers it. What
   * is testable here is the positive: the value on the fabric is the
   * authenticated one, and it is the only place it could have come from. */
  it("names the connection's own identity and environment on the fabric", async () => {
    const channel = randomUUID();
    const instance = await boot({
      user: "mai",
      channels: [channel],
      environment: "env-7",
    });
    open.push(instance.close);
    const watcher = await watch(channel);
    open.push(watcher.close);

    const socket = connect(instance);
    await acked(socket);
    socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle();

    expect(watcher.signals).toEqual([
      { environment: "env-7", channel, user: "mai" },
    ]);
  });
  /** Every collector in this file filters by CHANNEL and by TYPE (T049).
   *
   * Chapter 3.20 counted `presence.changed` frames by type alone and read two
   * where a watcher correctly saw their own arrival — the fourth occurrence of
   * that mistake across two chapters. A socket here can carry a
   * `connection.ack`, a `message.created` and a typing frame for a channel the
   * test is not asking about, and only the pair narrows it to the subject. */
  const typingFor = (
    frames: { type: string; payload?: { channel?: string; user?: string } }[],
    channel: string,
  ): { channel?: string; user?: string }[] =>
    frames
      .filter((f) => f.type === "typing" && f.payload?.channel === channel)
      .map((f) => f.payload as { channel?: string; user?: string });

  const collect = (
    socket: WebSocket,
  ): { type: string; payload?: { channel?: string; user?: string } }[] => {
    const frames: { type: string; payload?: { channel?: string; user?: string } }[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    return frames;
  };

  /** **POLL FOR AN ARRIVAL, NEVER SLEEP FOR ONE.**
   *
   * A connection is acked before its Redis SUBSCRIBE has necessarily landed: the
   * non-resume branch of `open()` acks without awaiting `subscribing`. So a test
   * that acks a watcher and immediately signals can miss the frame, and a fixed
   * `settle()` after the signal only makes that unlikely rather than impossible.
   *
   * Found the honest way — `sends nothing at all after the signal` failed once at
   * 315 ms in a run that passed on repeat, which is exactly the shape the
   * twenty-run battery exists to catch and exactly the shape that gets waved away
   * as "flaky". Negative assertions still use a fixed wait, because there is
   * nothing to poll for. */
  const untilTyping = async (
    frames: { type: string; payload?: { channel?: string; user?: string } }[],
    channel: string,
    count: number,
    ms = 4_000,
  ): Promise<{ channel?: string; user?: string }[]> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = typingFor(frames, channel);
      if (found.length >= count) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `only ${found.length} of ${count} typing frames for ${channel}; saw ${frames
            .map((f) => f.type)
            .join(", ")}`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /** The fabric-side twin of `untilTyping`: poll a subscriber for N signals.
   *
   * Needed for the same reason and one more — an instance publishing through the
   * TCP proxy opens a fresh connection through an extra hop, and the first
   * publish after a boot can land later than a fixed 300 ms wait. That is what
   * `expected [] to have a length of 1` was, and it is a property of the fixture
   * rather than of the code. */
  const untilSignals = async (
    watcher: { signals: unknown[] },
    count: number,
    ms = 5_000,
  ): Promise<unknown[]> => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (watcher.signals.length >= count) return watcher.signals;
      if (Date.now() > deadline) {
        throw new Error(
          `only ${watcher.signals.length} of ${count} signals reached the fabric`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /** T044. CROSS-INSTANCE, which is the only delivery that proves the fabric.
   *
   * Two instances, one channel, one signal. If both sockets lived on one gateway
   * the test would pass against an implementation that never published at all —
   * `subscribersOf` would find the watcher in the same registry. */
  it("delivers one frame to a member on another instance, naming the signaller", async () => {
    const channel = randomUUID();
    const tuan = await boot({ user: "tuan", channels: [channel] });
    const mai = await boot({ user: "mai", channels: [channel] });
    open.push(tuan.close, mai.close);

    const watcher = connect(mai);
    const frames = collect(watcher);
    await acked(watcher);

    const signaller = connect(tuan);
    await acked(signaller);
    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));

    expect(await untilTyping(frames, channel, 1)).toEqual([
      { channel, user: "tuan" },
    ]);
  });

  /** T045. THE SIGNALLER RECEIVES NOTHING, in the same run in which someone else
   * does — which is what makes it an assertion about the filter rather than
   * about a fabric that is asleep. Chapter 3.19's presence collector was
   * unfiltered in three consecutive phases and every time the behaviour was
   * right and the assertion was wrong. */
  it("sends the signaller nothing while another member receives", async () => {
    const channel = randomUUID();
    const tuan = await boot({ user: "tuan", channels: [channel] });
    const mai = await boot({ user: "mai", channels: [channel] });
    open.push(tuan.close, mai.close);

    const signaller = connect(tuan);
    const own = collect(signaller);
    await acked(signaller);
    const watcher = connect(mai);
    const theirs = collect(watcher);
    await acked(watcher);

    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));

    expect(await untilTyping(theirs, channel, 1)).toEqual([
      { channel, user: "tuan" },
    ]);
    expect(typingFor(own, channel)).toEqual([]);
  });

  /** T045b. THE SIGNALLER'S OWN SECOND CONNECTION RECEIVES NOTHING EITHER.
   *
   * **The test above cannot see this**, and that is the whole reason this one
   * exists: with one connection per user it passes whether the filter compares
   * identities or sockets. The wrong implementation shows a user their own
   * indicator on their own second device, and FR-011a requires the topology to
   * exist by making the renewal interval per connection. */
  it("sends nothing to the signaller's OTHER connection, which a socket filter would", async () => {
    const channel = randomUUID();
    const tuan = await boot({ user: "tuan", channels: [channel] });
    const alsoTuan = await boot({ user: "tuan", channels: [channel] });
    const mai = await boot({ user: "mai", channels: [channel] });
    open.push(tuan.close, alsoTuan.close, mai.close);

    const signaller = connect(tuan);
    await acked(signaller);
    const second = connect(alsoTuan);
    const secondFrames = collect(second);
    await acked(second);
    const watcher = connect(mai);
    const watcherFrames = collect(watcher);
    await acked(watcher);

    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));

    expect(await untilTyping(watcherFrames, channel, 1)).toEqual([
      { channel, user: "tuan" },
    ]);
    expect(typingFor(secondFrames, channel)).toEqual([]);
  });

  /** T046. A MEMBER OF A DIFFERENT CHANNEL RECEIVES NOTHING, in a run where a
   * member of the signalled channel does. A must-not-receive test that passes
   * because the producer is dead proves nothing. */
  it("reaches no one in another channel, while reaching the right channel", async () => {
    const signalled = randomUUID();
    const other = randomUUID();
    const tuan = await boot({ user: "tuan", channels: [signalled] });
    const mai = await boot({ user: "mai", channels: [signalled] });
    const someoneElse = await boot({ user: "linh", channels: [other] });
    open.push(tuan.close, mai.close, someoneElse.close);

    const watcher = connect(mai);
    const watched = collect(watcher);
    await acked(watcher);
    const outsider = connect(someoneElse);
    const outside = collect(outsider);
    await acked(outsider);

    const signaller = connect(tuan);
    await acked(signaller);
    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel: signalled } }));

    expect(await untilTyping(watched, signalled, 1)).toEqual([
      { channel: signalled, user: "tuan" },
    ]);
    expect(outside.filter((f) => f.type === "typing")).toEqual([]);
  });

  /** T048. ANOTHER TENANT RECEIVES NOTHING, in the same run.
   *
   * The two connections share a channel id — deliberately, because that is the
   * case a channel-scoped subject cannot separate on its own. The subject is
   * `typing:{channel_id}` with no environment in it, so both instances are
   * subscribed to the same string and the refusal has to happen at delivery,
   * against the connection the gateway is about to write to. Principle I is
   * structural here rather than topological, and this is the test that says so. */
  it("refuses a signal whose environment does not match the connection, and logs it", async () => {
    const channel = randomUUID();
    const lines: Record<string, unknown>[] = [];
    const tuan = await boot({ user: "tuan", channels: [channel], environment: "env-1" });
    const other = await boot({
      user: "stranger",
      channels: [channel],
      environment: "env-2",
      lines,
    });
    open.push(tuan.close, other.close);

    const outsider = connect(other);
    const outsideFrames = collect(outsider);
    await acked(outsider);
    // T050: assert one KNOWN line before relying on the sink at all.
    expect(lines.some((l) => l["msg"] === "connection.opened")).toBe(true);

    const signaller = connect(tuan);
    await acked(signaller);
    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle();

    expect(typingFor(outsideFrames, channel)).toEqual([]);
    expect(
      lines.filter(
        (l) => l["msg"] === "typing.failed" && l["op"] === "environment_mismatch",
      ),
    ).toHaveLength(1);
  });

  /** T048a. NOTHING FOLLOWS A SIGNAL (FR-009a).
   *
   * **This is FR-RTM-08's actual obligation** — "the indicator expires with no
   * frame sent to end it" — and it had no task until analysis pass 1. The
   * assertion is on the watcher's WHOLE frame list rather than on the absence of
   * one type, because "the server sends nothing to end an indicator" is
   * otherwise satisfied by a server that sends nothing at all. */
  it("sends nothing at all after the signal, until another signal is sent", async () => {
    const channel = randomUUID();
    // **`renewalIntervalMs: 40`, AND PHASE 6 IS WHY.** This test was written in
    // phase 5 with the default and passed; phase 6 gave the default a two-second
    // debounce and the probe below — a second signal, sent to show the fabric is
    // still alive — landed inside it and was dropped. The failure was
    // `expected [ … ] to have a length of 2 but got 1`, and it is a P2 story's
    // mechanism changing a P1 story's test. The subject here is FR-009a's
    // silence, not the interval, so the interval is set out of the way.
    const tuan = await boot({
      user: "tuan",
      channels: [channel],
      renewalIntervalMs: 40,
    });
    const mai = await boot({ user: "mai", channels: [channel] });
    open.push(tuan.close, mai.close);

    const watcher = connect(mai);
    const frames = collect(watcher);
    await acked(watcher);
    const signaller = connect(tuan);
    await acked(signaller);

    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await untilTyping(frames, channel, 1);
    const afterSignal = frames.length;

    // **A SECOND AND A HALF, NOT FIVE AND A HALF, AND THE ARGUMENT IS THE
    // CHAPTER'S OWN.** The obvious version of this test waits past FR-RTM-08's
    // five seconds to watch the expiry instant go by unannounced. It cost 5.6 s,
    // tripped vitest's 5 s default timeout, and would have added its own weight
    // to a package that paces the lane — against roughly four seconds of
    // headroom in the whole budget.
    //
    // And it would have been waiting for nothing. **There is no server timer to
    // wait for**: no Redis key, no `setTimeout`, no row — the gateway does not
    // know an indicator exists, which is exactly why it cannot end one. The five
    // seconds live in the receiving client. So any silence window proves the same
    // property, and FR-009a names no duration.
    await settle(1_500);
    expect(frames).toHaveLength(afterSignal);

    // And the fabric is still alive, so the silence above was a decision.
    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    expect(await untilTyping(frames, channel, 2)).toHaveLength(2);
  }, 15_000);
  /** T048b. A TYPING SIGNAL SPENDS NO MESSAGE QUOTA (FR-014).
   *
   * **Moved out of US3 by analysis pass 1**, and the reason is worth keeping:
   * leaving it in a P2 story meant stopping after the MVP could ship a cosmetic
   * feature able to exhaust a customer's message budget.
   *
   * Asserted on the limiter itself rather than on a counter in Redis. The
   * requirement is that the typing branch never REACHES `limits.spend` — it
   * returns above it — and a recording double says exactly that, where a counter
   * reading would also pass if the branch spent and refunded. */
  it("never reaches the send limiter, however many signals arrive", async () => {
    const channel = randomUUID();
    const spends: string[] = [];
    const limits: GatewayLimits = {
      spend: async (_environmentId, operation): Promise<Decision> => {
        spends.push(operation);
        return {
          over: false,
          limit: 600,
          remaining: 599,
          resetSeconds: Math.floor(Date.now() / 1000) + 60,
          retryAfterSeconds: 1,
        };
      },
      close: async () => {},
    };
    const instance = await boot({ user: "tuan", channels: [channel], limits });
    open.push(instance.close);

    const socket = connect(instance);
    await acked(socket);
    // The handshake spends `connect`, which is chapter 3.11's and not this
    // chapter's business — recorded so the assertion below is about `send`.
    expect(spends).toEqual(["connect"]);

    for (let i = 0; i < 5; i += 1) {
      socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    }
    await settle();

    expect(spends.filter((op) => op === "send")).toEqual([]);
  });

  /** T048c. THE MID-CONNECTION JOIN (FR-004a).
   *
   * **The obvious test — a member who was in the channel at connect — passes
   * against an implementation that never touches chapter 3.20's `added`
   * branch.** So this one connects first, joins second, and signals third.
   *
   * Without `typing?.subscribe` in that branch, a user added mid-connection
   * receives messages and presence and no typing, and FR-004 is silently false
   * for exactly the case the previous chapter built. Found by analysis pass 2
   * reading `session.ts` rather than this feature's documents. */
  it("delivers to a member added to the channel mid-connection", async () => {
    const channel = randomUUID();
    const membership = createMembership({ url, logger: silent });
    open.push(async () => {
      await membership.close();
    });

    // Mai connects holding NOTHING, then is added.
    const mai = await boot({ user: "mai", channels: [], membership });
    const tuan = await boot({ user: "tuan", channels: [channel] });
    open.push(mai.close, tuan.close);

    const watcher = connect(mai);
    const frames = collect(watcher);
    await acked(watcher);

    // The api's half of chapter 3.20's fabric, published directly: what is under
    // test is whether the gateway's `added` branch subscribes the typing subject,
    // not whether the api can compose the event.
    //
    // **ON THE USER SUBJECT, NOT THE CHANNEL'S — and the first version of this
    // test used the channel's and delivered nothing.** That is the previous
    // chapter's central asymmetry, walked into from the outside: an ADDITION
    // cannot ride `member:{channel_id}`, because the instance holding the new
    // member is not subscribed to that channel yet. Which is precisely the case
    // under test here, since Mai connects holding nothing.
    const announcer = new Redis(url);
    open.push(async () => {
      announcer.disconnect();
    });
    await announcer.publish(
      subjectForUserMembership("env-1", "mai"),
      JSON.stringify({
        environment: "env-1",
        channel,
        user: "mai",
        change: "added",
      }),
    );
    await settle();

    const signaller = connect(tuan);
    await acked(signaller);
    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));

    expect(await untilTyping(frames, channel, 1)).toEqual([
      { channel, user: "tuan" },
    ]);
  });
  /** T057. REPEATED SIGNALS INSIDE THE INTERVAL PRODUCE AT MOST ONE PUBLISH.
   *
   * **Asserted on a raw `ioredis` subscriber, not on frame counts at a socket and
   * not through this chapter's own module.** Counting publishes through the code
   * that publishes is the shape chapter 3.18 warned about — a publisher that does
   * nothing satisfies it — and counting frames at a socket cannot distinguish one
   * publish from two when the second is deduplicated downstream. */
  it("publishes once for a burst inside the interval", async () => {
    const channel = randomUUID();
    const instance = await boot({
      user: "tuan",
      channels: [channel],
      renewalIntervalMs: 2_000,
    });
    open.push(instance.close);
    const watcher = await watch(channel);
    open.push(watcher.close);

    const socket = connect(instance);
    await acked(socket);
    for (let i = 0; i < 8; i += 1) {
      socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    }
    await settle();

    expect(watcher.signals).toHaveLength(1);
  });

  /** T060. THE INTERVAL BITES — as a case, not a source edit.
   *
   * The same burst against an instance built with `renewalIntervalMs: 0`
   * publishes eight times where the test above publishes once. **Edit-and-restore
   * is the proof form that has now failed twice** — chapter 3.20 ran it on two
   * orderings and got no failure either time, because both were unobservable — and
   * a proof written as a case stays in the suite instead of being something
   * somebody did once and wrote down. */
  it("publishes every signal when the interval is zero, which is what makes the test above a proof", async () => {
    const channel = randomUUID();
    const instance = await boot({
      user: "tuan",
      channels: [channel],
      renewalIntervalMs: 0,
    });
    open.push(instance.close);
    const watcher = await watch(channel);
    open.push(watcher.close);

    const socket = connect(instance);
    await acked(socket);
    for (let i = 0; i < 8; i += 1) {
      socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    }
    await settle();

    expect(watcher.signals).toHaveLength(8);
  });

  /** T047, MOVED HERE FROM PHASE 5 DURING IMPLEMENTATION. Both halves need an
   * interval, and the option that supplies one is this phase's.
   *
   * **BUILT WITH 40 ms RATHER THAN WAITING OUT TWO REAL SECONDS.** The gateway
   * package paces the lane at ~45 s and the whole budget has about four seconds of
   * headroom; chapter 3.20 tests a sixty-second backstop at 40 ms for the same
   * reason. And the wait below is 120 ms against a 40 ms interval — **never
   * exactly the interval**, which would put two deadlines on one instant reached
   * by two clocks, the shape that stranded a user online for ever in 3.19. */
  it("publishes again after the interval, and not inside it", async () => {
    const channel = randomUUID();
    const instance = await boot({
      user: "tuan",
      channels: [channel],
      renewalIntervalMs: 40,
    });
    open.push(instance.close);
    const watcher = await watch(channel);
    open.push(watcher.close);

    const socket = connect(instance);
    await acked(socket);

    socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle(120);
    expect(watcher.signals, "the second was inside the interval").toHaveLength(1);

    socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle();
    expect(watcher.signals, "the third was after it").toHaveLength(2);
  });

  /** T058. A DROPPED SIGNAL WRITES NO LOG LINE (FR-013).
   *
   * The sink is captured across the burst and compared before and after. **A line
   * per keystroke is the unbounded output NFR-OBS-01 exists to prevent**, and this
   * is the first refusal in the platform that answers with nothing at all — so
   * "nothing" has to include the log, not just the wire. */
  it("drops a signal with no frame, no close and no log line", async () => {
    const channel = randomUUID();
    const lines: Record<string, unknown>[] = [];
    const instance = await boot({
      user: "tuan",
      channels: [channel],
      renewalIntervalMs: 2_000,
      lines,
    });
    open.push(instance.close);

    const socket = connect(instance);
    const frames = collect(socket);
    await acked(socket);

    socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle();
    const afterFirst = lines.length;
    expect(lines.some((l) => l["msg"] === "typing.published")).toBe(true);

    for (let i = 0; i < 6; i += 1) {
      socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    }
    await settle();

    expect(lines).toHaveLength(afterFirst);
    expect(frames.filter((f) => f.type === "error")).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  /** T059 and T059a. THE INTERVAL IS PER CONNECTION AND PER CHANNEL (FR-011a),
   * and the same topology answers a second question.
   *
   * Two connections of one user in one channel both publish — a well-behaved
   * client and a hostile one cost the fabric the same, and the state is per
   * connection rather than per user. And one connection typing in two channels
   * publishes twice.
   *
   * **T059a rides the same fixture**: the signaller's OTHER connection receives
   * nothing, which T045 cannot see because with one connection per user it passes
   * whether the filter compares identities or sockets. */
  it("debounces per connection and per channel, and still tells neither of the user's own sockets", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const tuanA = await boot({
      user: "tuan",
      channels: [first, second],
      renewalIntervalMs: 2_000,
    });
    const tuanB = await boot({
      user: "tuan",
      channels: [first],
      renewalIntervalMs: 2_000,
    });
    const mai = await boot({ user: "mai", channels: [first] });
    open.push(tuanA.close, tuanB.close, mai.close);

    const watchFirst = await watch(first);
    const watchSecond = await watch(second);
    open.push(watchFirst.close, watchSecond.close);

    const a = connect(tuanA);
    const aFrames = collect(a);
    await acked(a);
    const b = connect(tuanB);
    const bFrames = collect(b);
    await acked(b);
    const watcher = connect(mai);
    const watcherFrames = collect(watcher);
    await acked(watcher);

    // Two connections of one user, one channel: the interval is per connection,
    // so both publish.
    a.send(JSON.stringify({ type: "typing.send", payload: { channel: first } }));
    b.send(JSON.stringify({ type: "typing.send", payload: { channel: first } }));
    await settle();
    expect(watchFirst.signals).toHaveLength(2);

    // One connection, a second channel: the interval is per channel, so it
    // publishes again despite having just published.
    a.send(JSON.stringify({ type: "typing.send", payload: { channel: second } }));
    await settle();
    expect(watchSecond.signals).toHaveLength(1);

    // T059a. Neither of Tuan's sockets heard either of Tuan's signals, and Mai
    // heard both — so the silence is the identity filter and not a dead fabric.
    expect(await untilTyping(watcherFrames, first, 2)).toHaveLength(2);
    expect(typingFor(aFrames, first)).toEqual([]);
    expect(typingFor(bFrames, first)).toEqual([]);
  });
  /** T063. A TYPING FRAME ARRIVING MID-RESUME IS SENT IMMEDIATELY (FR-018).
   *
   * **CHAPTER 3.20's EQUIVALENT PASSED TWICE WITH ITS SUBJECT DELETED**, and its
   * record in `specs/038-chapter-3-20/baseline.txt` is what this test is built
   * against. Both of its traps are handled here:
   *
   *   the connection was not buffering — a connection is born `buffering` only
   *     when a CURSOR is presented (`session.ts:766`), and only until
   *     `api.backfill` returns, which is about twenty milliseconds on this lane.
   *     So the socket below presents a cursor and the stub sleeps 800 ms.
   *   the cursor and the frame had the same sequence — does not apply to typing,
   *     which carries no sequence at all. That absence is why the frame cannot be
   *     buffered meaningfully in the first place.
   *
   * **THE ASSERTION IS AN ORDERING, not an arrival.** A buffered frame still
   * arrives — after the flush — so "it arrived" proves nothing. What separates
   * the two is that an immediate frame arrives BEFORE the backfilled
   * `message.created`, and a buffered one after it. */
  it("sends a typing frame during a resume, before the backfill it is racing", async () => {
    const channel = randomUUID();
    const mai = await boot({
      user: "mai",
      channels: [channel],
      backfillDelayMs: 800,
      backfillFrames: {
        [channel]: {
          messages: [
            {
              id: randomUUID(),
              channel,
              seq: 9,
              user: "tuan",
              text: "backfilled",
              // Chapter 3.24: this payload goes onto the fabric as JSON and the gateway
              // PARSES it, so `tsc` never saw the construction — `JSON.stringify` takes
              // anything. Required means the parse refuses it without the field.
              attachments: [],
              created_at: new Date(0).toISOString(),
            },
          ],
          truncated: false,
        },
      },
    });
    const tuan = await boot({ user: "tuan", channels: [channel] });
    open.push(mai.close, tuan.close);

    // The signaller first, and acked, so nothing below waits on it.
    const signaller = connect(tuan);
    await acked(signaller);

    // **DO NOT AWAIT THE WATCHER'S ACK.** On the resume path the order is
    // "confirm, backfill, ack, emit, flush, live" (`session.ts`'s own comment),
    // so the ack goes out AFTER `api.backfill` returns. The first version of this
    // test awaited it and had therefore already slept through the whole 800 ms
    // window it was trying to test — the backfilled frame arrived within 300 ms
    // and the assertion read `expected [ { type: 'message.created' } ] to deeply
    // equal []`. **A wait for the wrong signal closes the window it was meant to
    // hold open.**
    //
    // A cursor BELOW the backfilled frame's sequence, so the flush has something
    // to deliver and the ordering below means something.
    const watcher = new WebSocket(`${mai.url}?token=${VALID_TOKEN}&cursor=${channel}:1`);
    sockets.push(watcher);
    const frames = collect(watcher);

    // Inside the 800 ms window: the connection is registered at upgrade and
    // `buffering` until the backfill returns.
    await settle(250);
    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle(250);
    expect(typingFor(frames, channel)).toHaveLength(1);
    expect(frames.filter((f) => f.type === "message.created")).toEqual([]);

    // And the backfill still arrives afterwards, so the resume was real.
    await settle(900);
    expect(frames.filter((f) => f.type === "message.created")).toHaveLength(1);
    const typingAt = frames.findIndex((f) => f.type === "typing");
    const backfilledAt = frames.findIndex((f) => f.type === "message.created");
    expect(typingAt).toBeLessThan(backfilledAt);
  }, 15_000);

  /** T064. A RECONNECTING CLIENT RECEIVES NO TYPING FRAMES FOR SIGNALS SENT WHILE
   * IT WAS AWAY (FR-018, SC-009).
   *
   * **A typing indicator replayed after a reconnect is a claim about the present
   * that was true five seconds ago.** Nothing stores one, so there is nothing to
   * replay — and this test is what turns that from an argument into a fact. */
  it("replays no typing frames to a client that reconnects", async () => {
    const channel = randomUUID();
    const mai = await boot({ user: "mai", channels: [channel] });
    const tuan = await boot({ user: "tuan", channels: [channel] });
    open.push(mai.close, tuan.close);

    const first = connect(mai);
    await acked(first);
    const signaller = connect(tuan);
    await acked(signaller);

    // Signalled while Mai is connected, so the fabric is demonstrably working.
    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle();

    first.close();
    await settle(200);

    // Signalled while Mai is away. Two of them, past the interval, so the
    // publisher is not debouncing them into one.
    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle(2_100);
    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle();

    const second = new WebSocket(`${mai.url}?token=${VALID_TOKEN}&cursor=${channel}:1`);
    sockets.push(second);
    const frames = collect(second);
    await acked(second);
    await settle(500);

    expect(typingFor(frames, channel)).toEqual([]);
  }, 15_000);
  /** T068 and T071. THE FABRIC SEVERED, AND RESTORED.
   *
   * A publish failure must not fail the connection, the send, or a message
   * delivery (FR-015). The socket stays open and the client is told nothing.
   *
   * **THE TITLE SAID "logs it once" UNTIL T098 READ IT AGAINST THE BODY**, and
   * the body proves the opposite: five `op: "connection"` lines and zero
   * `op: "publish"`. FR-015's third clause is what this test refutes, so a title
   * quoting that clause was a good test under a false name — chapter 3.19's
   * exact failure, in this chapter's own file.
   *
   * Then the proxy re-listens on the SAME port and the next signal publishes with
   * no restart, which is what ioredis's default retry on the publisher buys. */
  it("survives a severed fabric, logs the CONNECTION failure rather than a publish one, and publishes again when it returns", async () => {
    const channel = randomUUID();
    const lines: Record<string, unknown>[] = [];
    const proxy = await startRedisProxy();
    open.push(proxy.close);

    const instance = await boot({
      user: "tuan",
      channels: [channel],
      redisUrl: proxy.url,
      renewalIntervalMs: 0,
      lines,
    });
    open.push(instance.close);
    // Watched through the REAL Redis, not the proxy: the assertion is about what
    // reached the fabric, and a watcher behind the same proxy would be cut too.
    const watcher = await watch(channel);
    open.push(watcher.close);

    const socket = connect(instance);
    const frames = collect(socket);
    await acked(socket);

    socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    expect(await untilSignals(watcher, 1)).toHaveLength(1);

    await proxy.cut();
    const beforeFailure = lines.length;

    socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle(600);

    // The client learns nothing and keeps its socket. This is FR-015's first two
    // clauses and they hold.
    expect(frames.filter((f) => f.type === "error")).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    // **AND THE PUBLISH DOES NOT FAIL, WHICH FR-015 DID NOT EXPECT.**
    //
    // Measured rather than assumed. After the cut the sink holds five lines and
    // every one of them is `typing.failed` with `op: "connection"` — ioredis's
    // error listener firing once per reconnect attempt on each of the two
    // clients. There is no `op: "publish"` line at all, because
    // `publisher.publish()` never rejects: ioredis's default offline queue
    // accepts the command and resolves it when the connection returns.
    //
    // So a severed fabric does not drop this signal. It DELAYS it — which is
    // better for the product and worse for the requirement, because FR-015 says a
    // failure "MUST be logged once" and what is logged once per outage is
    // nothing, while what is logged per retry is unbounded. **A publisher that
    // queues satisfies "the socket stayed open" the way chapter 3.18's fan-out
    // satisfied "the send returned 201 while Redis was down": trivially.**
    //
    // Not fixed here. All four fabric modules share this listener shape, and
    // bounding it is a cross-module decision rather than this chapter's — it goes
    // to `gaps.md` with the measurement attached.
    const afterCut = lines.slice(beforeFailure);
    expect(afterCut.length).toBeGreaterThan(0);
    expect(
      afterCut.filter((l) => l["msg"] === "typing.failed" && l["op"] === "connection")
        .length,
    ).toBe(afterCut.length);
    expect(
      afterCut.filter((l) => l["op"] === "publish"),
      "the publish queues rather than failing",
    ).toEqual([]);

    await proxy.restore();
    // ioredis reconnects on its own; nothing here is rebuilt.
    await settle(1_200);
    socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    expect((await untilSignals(watcher, 2)).length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  /** T069 and T070. THE LOG VOCABULARY, AS THE SET AN INSTANCE ACTUALLY EMITTED.
   *
   * **Not as what a grep finds.** Chapter 3.20's FR-032 declared three names while
   * the code emitted six — `rejected`, `granted`, `revoked` and `revoked_all`
   * beside the two it shared — and the clause had to be amended with its argument
   * afterwards. A set assertion is what would have caught that on the day.
   *
   * T070 rides the same instance: **no name is emitted for a signal dropped
   * inside the renewal interval.** It is expected traffic rather than a failure,
   * and one line per keystroke over the limit is the unbounded output NFR-OBS-01
   * exists to prevent. */
  it("emits the two names this run reaches, and none at all for a debounced signal", async () => {
    const channel = randomUUID();
    const lines: Record<string, unknown>[] = [];
    const instance = await boot({
      user: "tuan",
      channels: [channel],
      renewalIntervalMs: 5_000,
      lines,
    });
    open.push(instance.close);

    const socket = connect(instance);
    await acked(socket);

    // One publish, then a burst inside the interval that must be silent.
    socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle();
    const afterPublish = lines.length;
    for (let i = 0; i < 5; i += 1) {
      socket.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    }
    await settle();
    expect(lines, "a debounced signal writes nothing").toHaveLength(afterPublish);

    // An unparseable body on the subject, to reach the third name.
    const injector = new Redis(url);
    await injector.publish(subjectForTyping(channel), "{ not json");
    await injector.publish(
      subjectForTyping(channel),
      JSON.stringify({ environment: "env-1", channel, user: "x", state: "no" }),
    );
    injector.disconnect();
    await settle();

    const emitted = new Set(
      lines
        .map((l) => String(l["msg"]))
        .filter((msg) => msg.startsWith("typing.")),
    );
    expect([...emitted].sort()).toEqual([
      "typing.invalid_payload",
      "typing.published",
    ]);
    // `typing.failed` is the third declared name and is reached by the severed
    // fabric test above and by the environment mismatch earlier in this file —
    // asserted there rather than forced here, because a name reached only by a
    // test that exists to reach it is a name nothing needs.
  });
  /** T072. FR-017's CROSS-KIND PROPERTY: four fabrics, one channel, one watcher.
   *
   * **Five subject shapes now share one Redis** — `chan:{id}`,
   * `presence:{id}`, `member:{id}`, `member:{env}:{user}` and `typing:{id}` —
   * and every gateway subscribes to a string. This is the test that says the
   * topology holds: each kind arrives ONCE, under its OWN `type`, and no kind
   * arrives as another.
   *
   * `typing.test.ts`'s pairwise-distinctness test proves the SUBJECTS cannot
   * collide; this proves the DELIVERY does not, which is a different claim. A
   * builder can be distinct while a handler is wired to the wrong one. */
  it("keeps four kinds apart over one channel, each arriving once under its own type", async () => {
    const channel = randomUUID();
    const instance = await boot({
      user: "mai",
      channels: [channel],
      allFabrics: true,
    });
    open.push(instance.close);

    const socket = connect(instance);
    const frames = collect(socket);
    await acked(socket);
    // The subscribes are in flight at ack time, so give all four a moment before
    // publishing into them.
    await settle(400);

    const publisher = new Redis(url);
    open.push(async () => {
      publisher.disconnect();
    });

    await publisher.publish(
      subjectForChannel(channel),
      JSON.stringify({
        id: randomUUID(),
        channel,
        seq: 4_242,
        user: "tuan",
        text: "one message",
        // Chapter 3.24: this payload goes onto the fabric as JSON and the gateway
        // PARSES it, so `tsc` never saw the construction — `JSON.stringify` takes
        // anything. Required means the parse refuses it without the field.
        attachments: [],
        created_at: new Date(0).toISOString(),
      }),
    );
    await publisher.publish(
      subjectForPresence(channel),
      JSON.stringify({
        environment: "env-1",
        channel,
        user: "tuan",
        state: "online",
        transition: randomUUID(),
      }),
    );
    await publisher.publish(
      subjectForChannelMembership(channel),
      JSON.stringify({
        environment: "env-1",
        channel,
        user: "linh",
        change: "added",
      }),
    );
    await publisher.publish(
      subjectForTyping(channel),
      JSON.stringify({ environment: "env-1", channel, user: "tuan" }),
    );

    await settle(700);

    const byType = (type: string): unknown[] =>
      frames.filter((f) => f.type === type);
    expect(byType("message.created"), "message").toHaveLength(1);
    expect(byType("presence.changed"), "presence").toHaveLength(1);
    expect(byType("membership.changed"), "membership").toHaveLength(1);
    expect(typingFor(frames, channel), "typing").toEqual([
      { channel, user: "tuan" },
    ]);
    // And nothing arrived twice or under a borrowed name: four publishes, four
    // frames, plus the `connection.ack` the handshake sent.
    expect(frames.filter((f) => f.type !== "connection.ack")).toHaveLength(4);
  }, 15_000);
});

/** THE MODULE'S OWN ARMS, driven directly rather than through a gateway.
 *
 * Four of `typing.ts`'s branches are not reachable from a socket, and the
 * coverage ratchet found all four at 100/100/100/100's expense: the url default,
 * the `onSignal` no-op, and both sides of the reference count. **None of them is
 * dead code** — which is the question T097 asks first, because this project's
 * ratchet has removed code five times rather than covered it. They are reachable
 * and nothing had reached them.
 */
describe("createTyping's own arms (chapter 3.21)", () => {
  const built: Typing[] = [];

  afterEach(async () => {
    for (const t of built.splice(0)) await t.close();
  });

  const make = (options: Partial<Parameters<typeof createTyping>[0]> = {}): Typing => {
    const t = createTyping({ url, logger: silent, ...options });
    built.push(t);
    return t;
  };

  it("falls back to DEFAULT_REDIS_URL when neither a url nor the env var is given", async () => {
    const saved = process.env["RELAY_REDIS_URL"];
    delete process.env["RELAY_REDIS_URL"];
    try {
      // No `url`, no env var: the default parameter's right-hand side. The
      // default happens to be the store this lane runs, so the client connects
      // and the test is about the branch rather than about reachability.
      const t = createTyping({ logger: silent });
      built.push(t);
      const channel = randomUUID();
      let delivered: unknown;
      t.onSignal((signal) => {
        delivered = signal;
      });
      await t.subscribe(channel);
      await t.publish({ environment: "env-1", channel, user: "tuan" });
      await settle();
      // **ASSERTED, not merely exercised.** The first version of this test had no
      // `expect` at all: it took the branch, moved the coverage number, and
      // proved nothing about where the client connected. A round trip through
      // the fallback url is what says the default is the store this lane runs.
      expect(delivered).toEqual({ environment: "env-1", channel, user: "tuan" });
    } finally {
      if (saved === undefined) delete process.env["RELAY_REDIS_URL"];
      else process.env["RELAY_REDIS_URL"] = saved;
    }
  });

  it("drops a signal on the floor when no handler is wired", async () => {
    // `deliver` starts as a no-op and every other test in this file replaces it
    // through `attachSessions`. A module built and subscribed but never wired is
    // the shape a gateway has for the instant between construction and wiring.
    const channel = randomUUID();
    const receiver = make();
    await receiver.subscribe(channel);

    // A SECOND receiver, wired, on the same subject. Without it this test would
    // assert nothing about its own subject: "no throw" is also true of a module
    // that never received the signal at all. The wired one proves the publish
    // landed, so the unwired one's silence is the no-op default running.
    const wired = make();
    let delivered = 0;
    wired.onSignal(() => {
      delivered += 1;
    });
    await wired.subscribe(channel);

    const sender = make();
    await sender.publish({ environment: "env-1", channel, user: "tuan" });
    await settle();

    expect(delivered, "the wired module received it, so the publish landed").toBe(1);
  });

  it("counts references: a second subscribe does not re-subscribe, and one release does not unsubscribe", async () => {
    const channel = randomUUID();
    const receiver = make();
    let delivered = 0;
    receiver.onSignal(() => {
      delivered += 1;
    });

    // Two holders of one channel on one instance — two connections of one user,
    // or two users. The second `subscribe` finds a count and increments it.
    await receiver.subscribe(channel);
    await receiver.subscribe(channel);

    // One releases. The subscription must survive, because the other holder is
    // still there — this is the arm that would silently break the remaining
    // member's typing if the count were not kept.
    await receiver.unsubscribe(channel);

    const sender = make();
    await sender.publish({ environment: "env-1", channel, user: "tuan" });
    await settle();
    expect(delivered, "still subscribed after one of two releases").toBe(1);

    // The last release does unsubscribe.
    await receiver.unsubscribe(channel);
    // And a release for a channel never held is not an error.
    await receiver.unsubscribe(randomUUID());

    await sender.publish({ environment: "env-1", channel, user: "mai" });
    await settle();
    expect(delivered, "unsubscribed after the last release").toBe(1);
  });
});
