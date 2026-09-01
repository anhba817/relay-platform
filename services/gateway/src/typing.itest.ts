import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { docsUrl, subjectForTyping } from "@relay/protocol";
import { createLogger, serve, type Logger } from "@relay/service-kit";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { ApiClient } from "./api-client.js";
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
}): Promise<Instance> {
  const environment = options.environment ?? "env-1";
  const typing = createTyping({ url, logger: silent });
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
  const sessions = attachSessions({ server, api, logger: silent, typing });
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
});
