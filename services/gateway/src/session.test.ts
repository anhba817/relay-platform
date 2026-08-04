import { SignJWT } from "jose";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createLogger, type Logger } from "@relay/service-kit";
import { serve } from "@relay/service-kit";
import type { Frame } from "@relay/protocol";

import type { InternalSendResponse } from "@relay/protocol";

import type { ApiClient } from "./api-client.js";
import { DEV_JWT_SECRET } from "./auth.js";
import type { Fanout } from "./fanout.js";
import { attachSessions } from "./session.js";

// The door, the frames, and the liveness clock — all provable without a
// database, because the gateway has no database (ADR-05). The api is a
// stub here for exactly that reason: if these tests needed Postgres, the
// gateway would be doing something it is not allowed to do.

const silent: Logger = createLogger("gateway", () => {});

// The stub cannot lie about the shape: ApiClient's types come from
// @relay/protocol's internal contract, so a partial response is a compile
// error here — the same guarantee the real client gets at runtime.
function committed(seq: number): InternalSendResponse {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channel_id: "11111111-1111-1111-1111-111111111111",
    seq,
    user: "tuan",
    text: "hello",
    created_at: new Date().toISOString(),
  };
}

function stubApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    memberships: async () => ["11111111-1111-1111-1111-111111111111"],
    sendMessage: async () => committed(42),
    ...overrides,
  };
}

async function token(claims: Record<string, string> = {}): Promise<string> {
  return new SignJWT({ env: "env-1", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("tuan")
    .sign(new TextEncoder().encode(DEV_JWT_SECRET));
}

interface Harness {
  url: string;
  close: () => Promise<void>;
}

/** A fabric that records instead of connecting. What gets published, and
 * in what order relative to the ack, is the gateway's decision — provable
 * without Redis. Chapter 2.6's itest covers the part that needs a broker. */
function stubFanout(): Fanout & { published: unknown[]; subjects: string[] } {
  const published: unknown[] = [];
  const subjects: string[] = [];
  return {
    published,
    subjects,
    onDelivery: () => {},
    publish: async (message) => {
      published.push(message);
    },
    subscribe: async (channelId) => {
      subjects.push(channelId);
    },
    unsubscribe: async () => {},
    close: async () => {},
  };
}

async function boot(
  api: ApiClient = stubApi(),
  pingIntervalMs?: number,
  fanout?: Fanout,
): Promise<Harness> {
  const server: Server = serve({
    service: "gateway",
    health: () => ({}),
    logger: silent,
  });
  const sessions = attachSessions({
    server,
    api,
    logger: silent,
    ...(fanout !== undefined && { fanout }),
    ...(pingIntervalMs !== undefined && { pingIntervalMs }),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/v1/ws`,
    close: async () => {
      sessions.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Collect frames until a predicate matches, or reject on close/timeout. */
function nextFrame(socket: WebSocket, type: Frame["type"]): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} frame`)), 2000);
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (frame.type === type) {
        clearTimeout(timer);
        resolve(frame);
      }
    });
    socket.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`closed ${code}`));
    });
  });
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.on("close", (code) => resolve(code)));
}

describe("the socket (chapter 2.5)", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("acks a valid connection with identity and a resume cursor (EIR-WS-03)", async () => {
    harness = await boot();
    const started = Date.now();
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    const ack = await nextFrame(socket, "connection.ack");
    // Inside EIR-WS-03's one-second budget, measured rather than asserted.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ack).toMatchObject({
      type: "connection.ack",
      payload: { user: "tuan", resume_ok: true, truncated: [] },
    });
    socket.close();
  });

  it("rejects a bad token with 4001 before any frame (EIR-WS-05)", async () => {
    harness = await boot();
    for (const bad of ["", "not-a-jwt", await token({ env: "" })]) {
      const socket = new WebSocket(`${harness.url}?token=${bad}`);
      expect(await closeCode(socket)).toBe(4001);
    }
  });

  it("forwards message.send to the api and acks the committed sequence", async () => {
    const sent: unknown[] = [];
    harness = await boot(
      stubApi({
        sendMessage: async (identity, body) => {
          sent.push({ identity, body });
          return committed(7);
        },
      }),
    );
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(socket, "connection.ack");
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: { idem_key: "k1", channel: "c1", text: "hello" },
      }),
    );
    const ack = await nextFrame(socket, "message.ack");
    expect(ack).toMatchObject({ type: "message.ack", payload: { seq: 7 } });
    // The gateway carried; the api decided. The identity travelled with it.
    expect(sent).toEqual([
      {
        identity: { userExternalId: "tuan", environmentId: "env-1" },
        body: { channel_id: "c1", text: "hello", idempotency_key: "k1" },
      },
    ]);
    socket.close();
  });

  it("answers garbage with the protocol's error envelope", async () => {
    harness = await boot();
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(socket, "connection.ack");
    socket.send("this is not json");
    const error = await nextFrame(socket, "error");
    expect(error).toMatchObject({
      type: "error",
      payload: { code: "invalid_frame" },
    });
    socket.close();
  });

  it("closes with 4002 when a client utters a server-only frame (EIR-WS-06)", async () => {
    harness = await boot();
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(socket, "connection.ack");
    // message.ack is the SERVER's word. A client sending it is not
    // malformed input — it is a protocol violation.
    socket.send(JSON.stringify({ type: "message.ack", payload: { seq: 1 } }));
    expect(await closeCode(socket)).toBe(4002);
  });

  it("closes a socket that stops answering pings (EIR-WS-04)", async () => {
    // The interval is injectable so the contract can be tested in
    // milliseconds instead of a minute and a half.
    harness = await boot(stubApi(), 20);
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(socket, "connection.ack");
    socket.pong = () => {}; // stop answering
    expect(await closeCode(socket)).toBe(1001);
  });
  it("subscribes to every channel the session can hear (chapter 2.6)", async () => {
    const fanout = stubFanout();
    harness = await boot(stubApi(), undefined, fanout);
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(socket, "connection.ack");
    // Membership decides subscriptions: an instance hears exactly the
    // channels its local sockets belong to, nothing more.
    expect(fanout.subjects).toEqual(["11111111-1111-1111-1111-111111111111"]);
    socket.close();
  });

  it("acks the handshake even when the fabric never answers (chapter 2.6)", async () => {
    const fanout = stubFanout();
    // A broker that is down, modelled honestly: subscribe never settles.
    // ioredis queues the command and replays it on reconnect, so the
    // promise can stay pending indefinitely.
    fanout.subscribe = () => new Promise<void>(() => {});
    harness = await boot(stubApi(), undefined, fanout);
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    // EIR-WS-03's budget is not negotiable, and the fabric is the one
    // dependency here that is ALLOWED to be down (ADR-07). Awaiting the
    // subscribe made a stopped Redis stop connections — worse than the
    // dropped frames at-most-once already permits.
    const ack = await nextFrame(socket, "connection.ack");
    expect(ack).toMatchObject({ type: "connection.ack" });
    socket.close();
  });

  it("publishes the committed message only after the ack (chapter 2.6)", async () => {
    const fanout = stubFanout();
    harness = await boot(stubApi(), undefined, fanout);
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(socket, "connection.ack");
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          // idem_key is REQUIRED by the wire contract (2.3): every socket
          // send is retryable by construction, which is exactly why the
          // republish rule below matters.
          idem_key: "k-0",
          channel: "11111111-1111-1111-1111-111111111111",
          text: "hello",
        },
      }),
    );
    await nextFrame(socket, "message.ack");
    // The published frame is the WIRE shape, not the internal response:
    // `channel`, not `channel_id`, and a sender that came back from the
    // api rather than being asserted by the gateway.
    expect(fanout.published).toEqual([
      {
        id: "00000000-0000-0000-0000-000000000001",
        channel: "11111111-1111-1111-1111-111111111111",
        seq: 42,
        user: "tuan",
        text: "hello",
        created_at: expect.any(String),
      },
    ]);
    socket.close();
  });

  it("does not republish a recognised retry (chapter 2.6's trap)", async () => {
    const fanout = stubFanout();
    harness = await boot(
      // The api recognised 2.3's idempotency key and returned the
      // ORIGINAL message. Storage stayed correct; delivery must not now
      // put the same message on every screen a second time.
      stubApi({
        sendMessage: async () => ({ ...committed(42), duplicate: true }),
      }),
      undefined,
      fanout,
    );
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(socket, "connection.ack");
    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: {
          channel: "11111111-1111-1111-1111-111111111111",
          text: "hello",
          idem_key: "k-1",
        },
      }),
    );
    // The sender is still acked — the retry SUCCEEDED, and FR-MSG-04 says
    // it looks like a first send.
    expect(await nextFrame(socket, "message.ack")).toMatchObject({
      payload: { seq: 42 },
    });
    expect(fanout.published).toEqual([]);
    socket.close();
  });
});
