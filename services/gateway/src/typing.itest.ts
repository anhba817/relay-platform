import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  docsUrl,
  subjectForTyping,
  subjectForUserMembership,
} from "@relay/protocol";
import { createLogger, serve, type Logger } from "@relay/service-kit";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { ApiClient } from "./api-client.js";
import type { Decision, GatewayLimits } from "./limits.js";
import { createMembership, type Membership } from "./membership.js";
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
}): Promise<Instance> {
  const environment = options.environment ?? "env-1";
  const logger =
    options.lines === undefined
      ? silent
      : createLogger("gateway", (line: string) => {
          options.lines?.push(JSON.parse(line) as Record<string, unknown>);
        });
  const typing = createTyping({ url, logger });
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
    backfill: async () => ({}),
    sendMessage: async () => {
      throw new Error("not used");
    },
    reportUsage: async () => null,
  };
  const sessions = attachSessions({
    server,
    api,
    logger,
    typing,
    ...(options.membership === undefined ? {} : { membership: options.membership }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/v1/ws`,
    typing,
    close: async () => {
      await sessions.close();
      await typing.close();
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
    await settle();

    expect(typingFor(frames, channel)).toEqual([{ channel, user: "tuan" }]);
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
    await settle();

    expect(typingFor(theirs, channel)).toEqual([{ channel, user: "tuan" }]);
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
    await settle();

    expect(typingFor(watcherFrames, channel)).toEqual([{ channel, user: "tuan" }]);
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
    await settle();

    expect(typingFor(watched, signalled)).toEqual([{ channel: signalled, user: "tuan" }]);
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
    const tuan = await boot({ user: "tuan", channels: [channel] });
    const mai = await boot({ user: "mai", channels: [channel] });
    open.push(tuan.close, mai.close);

    const watcher = connect(mai);
    const frames = collect(watcher);
    await acked(watcher);
    const signaller = connect(tuan);
    await acked(signaller);

    signaller.send(JSON.stringify({ type: "typing.send", payload: { channel } }));
    await settle();
    const afterSignal = frames.length;
    expect(typingFor(frames, channel)).toHaveLength(1);

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
    await settle();
    expect(typingFor(frames, channel)).toHaveLength(2);
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
    await settle();

    expect(typingFor(frames, channel)).toEqual([{ channel, user: "tuan" }]);
  });
});
