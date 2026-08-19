import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createLogger, type Logger } from "@relay/service-kit";
import { serve } from "@relay/service-kit";
import type { Frame } from "@relay/protocol";

import type { InternalSendResponse, Message } from "@relay/protocol";

import type { ApiClient } from "./api-client.js";
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
    // Chapter 3.2: the api verifies tokens, so the stub is what decides which
    // credential is good. That inversion is the point — the gateway holds no
    // secret and cannot check a signature, so there is nothing left here to
    // fake except the ANSWER.
    session: async (token) =>
      token === VALID_TOKEN
        ? { environment_id: "env-1", user: "tuan", channel_ids: [CHANNEL] }
        : null,
    backfill: async () => ({}),
    sendMessage: async () => committed(42),
    ...overrides,
  };
}

const CHANNEL = "11111111-1111-1111-1111-111111111111";

/** A backfilled or live frame, in the wire shape the api now returns. */
function frame(seq: number, channel = CHANNEL): Message {
  return {
    id: `id-${seq}`,
    channel,
    seq,
    user: "dispatcher",
    text: `m${seq}`,
    created_at: "2026-08-04T00:00:00.000Z",
  };
}

/** The one credential the stubbed api recognises. */
const VALID_TOKEN = "token-for-tuan";

/** A token, from the gateway's point of view: an opaque string it forwards.
 *
 * This function used to SIGN one, with HS256 over a development secret both the
 * gateway and this file knew. After chapter 3.2 neither of them holds a secret —
 * tokens are signed with the environment's own, in the api — so any override
 * here simply produces a DIFFERENT opaque string, which the stub refuses. The
 * refusal cases below therefore test what they always tested: a credential the
 * api will not accept never reaches session code. */
async function token(claims: Record<string, string> = {}): Promise<string> {
  const keys = Object.entries(claims);
  return keys.length === 0
    ? VALID_TOKEN
    : `token-with-${keys.map(([k, v]) => `${k}=${v}`).join(",")}`;
}

interface Harness {
  url: string;
  close: () => Promise<void>;
}

/** A fabric that records instead of connecting. What gets published, and
 * in what order relative to the ack, is the gateway's decision — provable
 * without Redis. Chapter 2.6's itest covers the part that needs a broker. */
function stubFanout(): Fanout & {
  published: unknown[];
  subjects: string[];
  /** Inject a live frame at a moment the test chooses. This is how the
   * flagship race gets reproduced deterministically instead of hopefully:
   * the api stub calls it from inside the backfill, so "a message published
   * during the backfill window" is a line of code, not a stress loop. */
  emit: (message: Message) => void;
} {
  const published: unknown[] = [];
  const subjects: string[] = [];
  let deliver: (channelId: string, message: Message) => void = () => {};
  return {
    published,
    subjects,
    // Honest about the fabric's one rule: a frame published to a subject
    // this instance has not subscribed to does NOT arrive. Without that,
    // the stub would silently paper over the gap variant of the race.
    emit: (message) => {
      if (subjects.includes(message.channel)) deliver(message.channel, message);
    },
    onDelivery: (handler) => {
      deliver = handler;
    },
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
  resumeDeadlineMs?: number,
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
    ...(resumeDeadlineMs !== undefined && { resumeDeadlineMs }),
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

  it("closes 1011, not 4001, when the api cannot answer at all", async () => {
    // New in chapter 3.2, and the reason `authenticate` has three outcomes
    // rather than two. Moving verification to the api introduced a failure the
    // gateway never had: the verifier being DOWN. Answering that with 4001
    // would tell a client its credential is bad and stop it retrying, when the
    // truth is that we are broken and it should.
    harness = await boot(
      stubApi({
        session: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    );
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    expect(await closeCode(socket)).toBe(1011);
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
    // The gateway carried; the api decided. The identity travelled with it —
    // and after chapter 3.2 the TOKEN travels too, because the internal hop
    // forwards the user's own credential rather than asserting who they are.
    expect(sent).toEqual([
      {
        identity: {
          userExternalId: "tuan",
          environmentId: "env-1",
          token: VALID_TOKEN,
        },
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
  // ── chapter 2.7: the tunnel ────────────────────────────────────────────
  //
  // Every test below turns the resume window into something a test can hold
  // still. `record` collects frames in arrival ORDER, because order is the
  // property under test: an ack, then the backfill, then the flush.

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

  async function settle(ms = 60): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("delivers the backfill after the ack, in sequence order (FR-RTM-03)", async () => {
    const fanout = stubFanout();
    harness = await boot(
      stubApi({
        backfill: async (_identity, cursors) => {
          // The cursor the client presented arrives verbatim.
          expect(cursors).toEqual({ [CHANNEL]: 41 });
          return {
            [CHANNEL]: { messages: [frame(42), frame(43)], truncated: false },
          };
        },
      }),
      undefined,
      fanout,
    );
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await nextFrame(socket, "connection.ack");
    await settle();
    expect(frames[0]).toMatchObject({
      type: "connection.ack",
      payload: { resume_ok: true, truncated: [], cursor: { [CHANNEL]: 41 } },
    });
    expect(created(frames)).toEqual([42, 43]);
    socket.close();
  });

  it("stages the race: a frame published DURING backfill is neither lost nor doubled", async () => {
    // The flagship bug (SAD §5.2). seq 43 is published while the backfill
    // is in flight, and the backfill ALSO contains it — the interleaving
    // where a naive subscribe-then-deliver sends it twice.
    const fanout = stubFanout();
    harness = await boot(
      stubApi({
        backfill: async () => {
          fanout.emit(frame(43));
          return {
            [CHANNEL]: { messages: [frame(42), frame(43)], truncated: false },
          };
        },
      }),
      undefined,
      fanout,
    );
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await nextFrame(socket, "connection.ack");
    await settle();
    const seqs = created(frames);
    expect(seqs).toEqual([42, 43]); // complete…
    expect(new Set(seqs).size).toBe(seqs.length); // …and exactly once
    socket.close();
  });

  it("chapter 3.7: a frame at the mark, arriving after the resume, is not delivered", async () => {
    // The same property `resume.itest.ts` proves against a real broker, held here
    // against a stubbed one so it fails fast and without Redis. This is the wiring
    // rather than the predicate: that `deliver()` consults the marks at all.
    const fanout = stubFanout();
    harness = await boot(
      stubApi({
        backfill: async () => ({
          [CHANNEL]: { messages: [frame(42)], truncated: false },
        }),
      }),
      undefined,
      fanout,
    );
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await nextFrame(socket, "connection.ack");
    await settle();
    // The resume is over. The fabric catches up with what the backfill sent.
    fanout.emit(frame(42));
    await settle();
    expect(created(frames)).toEqual([42]);
    socket.close();
  });

  it("chapter 3.7: a frame above the mark, arriving after the resume, IS delivered", async () => {
    // The half that stops a duplicate fix becoming a gap (FR-RTM-03 is one
    // property, not two: no gap AND no double).
    const fanout = stubFanout();
    harness = await boot(
      stubApi({
        backfill: async () => ({
          [CHANNEL]: { messages: [frame(42)], truncated: false },
        }),
      }),
      undefined,
      fanout,
    );
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await nextFrame(socket, "connection.ack");
    await settle();
    fanout.emit(frame(43));
    await settle();
    expect(created(frames)).toEqual([42, 43]);
    socket.close();
  });

  it("chapter 3.7: a connection that never resumed suppresses nothing", async () => {
    // A fresh connect presents no cursor, so it holds no marks and behaves
    // exactly as chapter 2.6 left it.
    const fanout = stubFanout();
    harness = await boot(stubApi({}), undefined, fanout);
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    const frames = record(socket);
    await nextFrame(socket, "connection.ack");
    await settle();
    fanout.emit(frame(1));
    await settle();
    expect(created(frames)).toEqual([1]);
    socket.close();
  });

  it("stages the other interleaving: published during backfill, absent from it", async () => {
    // Same window, the other order: seq 43 committed AFTER the backfill
    // query's snapshot, so it exists ONLY in the buffer. This is the
    // interleaving where backfill-then-subscribe loses the message.
    const fanout = stubFanout();
    harness = await boot(
      stubApi({
        backfill: async () => {
          fanout.emit(frame(43));
          return { [CHANNEL]: { messages: [frame(42)], truncated: false } };
        },
      }),
      undefined,
      fanout,
    );
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const frames = record(socket);
    await nextFrame(socket, "connection.ack");
    await settle();
    expect(created(frames)).toEqual([42, 43]);
    socket.close();
  });

  it("forwards per-channel truncation so the client pages history instead (FR-RTM-04)", async () => {
    const fanout = stubFanout();
    harness = await boot(
      stubApi({
        backfill: async () => ({
          [CHANNEL]: { messages: [frame(42)], truncated: true },
        }),
      }),
      undefined,
      fanout,
    );
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const ack = await nextFrame(socket, "connection.ack");
    expect(ack).toMatchObject({
      payload: { resume_ok: true, truncated: [CHANNEL] },
    });
    socket.close();
  });

  it("degrades honestly when the fabric will not confirm the subscription", async () => {
    const fanout = stubFanout();
    fanout.subscribe = () => new Promise<void>(() => {}); // broker down
    let asked = false;
    harness = await boot(
      stubApi({
        backfill: async () => {
          asked = true;
          return {};
        },
      }),
      undefined,
      fanout,
      20, // deadline in ms, injected like the ping interval
    );
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    const ack = await nextFrame(socket, "connection.ack");
    // resume_ok: false and the channel listed — the client refetches rather
    // than believing a stream that has a hole in it. And the backfill is
    // never requested: a resume that cannot be safe should not be expensive.
    expect(ack).toMatchObject({
      payload: { resume_ok: false, truncated: [CHANNEL] },
    });
    expect(asked).toBe(false);
    socket.close();
  });

  it("degrades on a malformed cursor rather than closing the door", async () => {
    harness = await boot(stubApi(), undefined, stubFanout());
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=garbage`,
    );
    const ack = await nextFrame(socket, "connection.ack");
    expect(ack).toMatchObject({ payload: { resume_ok: false } });
    socket.close();
  });

  it("degrades when the api cannot serve the backfill", async () => {
    harness = await boot(
      stubApi({
        backfill: async () => {
          throw new Error("api down");
        },
      }),
      undefined,
      stubFanout(),
    );
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}&cursor=${CHANNEL}:41`,
    );
    expect(await nextFrame(socket, "connection.ack")).toMatchObject({
      payload: { resume_ok: false, truncated: [CHANNEL] },
    });
    socket.close();
  });

  it("never buffers a fresh connect — 2.6's rule survives 2.7", async () => {
    // No cursor means no resume: the connection is born live and a live
    // frame goes straight out, no buffer, no flush. (That the ack does not
    // WAIT on the fabric is 2.6's test above; this one is about phase.)
    const fanout = stubFanout();
    harness = await boot(stubApi(), undefined, fanout);
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    const frames = record(socket);
    await nextFrame(socket, "connection.ack");
    fanout.emit(frame(1));
    await settle();
    expect(created(frames)).toEqual([1]);
    socket.close();
  });

  it("ignores a cursor for a channel the user is not a member of", async () => {
    let seen: Record<string, number> | undefined;
    harness = await boot(
      stubApi({
        backfill: async (_identity, cursors) => {
          seen = cursors;
          return {};
        },
      }),
      undefined,
      stubFanout(),
    );
    const socket = new WebSocket(
      `${harness.url}?token=${await token()}` +
        `&cursor=${CHANNEL}:41&cursor=99999999-9999-9999-9999-999999999999:7`,
    );
    await nextFrame(socket, "connection.ack");
    // The foreign cursor never reaches the api: membership is the bound on
    // resume work, and a channel the caller is not in is not a question.
    expect(seen).toEqual({ [CHANNEL]: 41 });
    socket.close();
  });
});
