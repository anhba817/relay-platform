import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createLogger, type Logger } from "@relay/service-kit";
import { serve } from "@relay/service-kit";
import { CLOSE_CODES, type Frame,
  docsUrl,
} from "@relay/protocol";

import type { InternalSendResponse, Message } from "@relay/protocol";

import type { ApiClient } from "./api-client.js";
import type { Fanout } from "./fanout.js";
import { decide, type GatewayLimits } from "./limits.js";
import { attachSessions, INBOUND_FRAME_TYPES } from "./session.js";

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
        ? {
            environment_id: "env-1",
            user: "tuan",
            // Chapter 3.15: the api now reports whether the user is banned, and a stub
            // that does not say is a stub that has not thought about it.
            banned: false,
            channel_ids: [CHANNEL],
            // Chapter 3.8. The limits ride the session response because the
            // gateway has no database to read them from — so the stub supplies
            // them, exactly as the api would. Generous by default: every test
            // above this line is about something else.
            limits: { connect: 3_000, send: 600 },
          }
        : null,
    backfill: async () => ({}),
    sendMessage: async () => committed(42),
    // Chapter 3.11. Null is what a gateway with no metering credential gets, and
    // it is the right default here: every test in this file is about the socket,
    // and a meter that reported would only add a call nobody asserts on.
    reportUsage: async () => null,
    // Chapter 3.20's backstop reads this. The default answers what the session
    // above says, so a stub that never overrides it is a stub whose re-read agrees
    // with its own connect — which is the state every test in this file that is not
    // about membership wants.
    memberships: async () => [CHANNEL],
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

/** A counter with no Redis in it (chapter 3.8). The arithmetic is unit-tested
 * in `limits.test.ts`; what these tests need is control over the ANSWER, so a
 * refusal is a line of code instead of three thousand sockets. */
function stubLimits(
  allowances: { connect?: number; send?: number } = {},
): GatewayLimits & { spent: { connect: number; send: number } } {
  const spent = { connect: 0, send: 0 };
  return {
    spent,
    spend: async (_environmentId, operation, limit) => {
      spent[operation] += 1;
      // The stub honours whichever allowance the test set, falling back to the
      // limit the session response carried — which is what makes T034a's
      // distinction visible: an allowance the test names here is the store's
      // view, `limit` is the socket's cached one.
      const allowed = allowances[operation] ?? limit;
      return decide(spent[operation], allowed, 0, 60_000);
    },
    close: async () => {},
  };
}

async function boot(
  api: ApiClient = stubApi(),
  pingIntervalMs?: number,
  fanout?: Fanout,
  resumeDeadlineMs?: number,
  limits?: GatewayLimits,
): Promise<Harness> {
  const server: Server = serve({
    service: "gateway",
    health: () => ({}),
    logger: silent,
    notFoundDocsUrl: docsUrl("not_found"),
  });
  const sessions = attachSessions({
    server,
    api,
    logger: silent,
    ...(fanout !== undefined && { fanout }),
    ...(pingIntervalMs !== undefined && { pingIntervalMs }),
    ...(resumeDeadlineMs !== undefined && { resumeDeadlineMs }),
    ...(limits !== undefined && { limits }),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/v1/ws`,
    close: async () => {
      await sessions.close();
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

// Chapter 3.8. The socket's two limits — one at the door, one on every frame —
// and the two shapes a refusal takes, which are different because a handshake
// has an HTTP response to write headers onto and a frame does not.
describe("the socket's limits (chapter 3.8)", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** The upgrade's HTTP answer, for the case where there is no WebSocket to
   * ask. `ws` surfaces a non-101 as `unexpected-response`, which hands back the
   * request and the raw `IncomingMessage` — status and headers included. */
  function unexpectedResponse(
    socket: WebSocket,
  ): Promise<{ status: number; headers: Record<string, string | undefined> }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no response")), 2000);
      socket.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | undefined>,
        });
      });
      socket.on("open", () => {
        clearTimeout(timer);
        reject(new Error("the handshake completed"));
      });
      socket.on("error", () => {});
    });
  }

  it("refuses an over-limit handshake with an HTTP 429, before the handshake (FR-RTL-03)", async () => {
    // An allowance of one, so the second connect is the refused one.
    harness = await boot(
      stubApi(),
      undefined,
      undefined,
      undefined,
      stubLimits({ connect: 1 }),
    );
    const first = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(first, "connection.ack");

    const second = new WebSocket(`${harness.url}?token=${await token()}`);
    const { status, headers } = await unexpectedResponse(second);
    expect(status).toBe(429);
    // The instruction, not just the refusal. This is the reason the limiter is
    // a fixed window: `Retry-After` and `X-RateLimit-Reset` both name one
    // moment, and a refilling bucket's honest answer would be a curve.
    expect(Number(headers["retry-after"])).toBeGreaterThan(0);
    expect(headers["x-ratelimit-limit"]).toBe("1");
    expect(headers["x-ratelimit-remaining"]).toBe("0");
    expect(headers["x-ratelimit-reset"]).toBeDefined();

    first.close();
  });

  it("leaves already-open sockets alone when the door is shut (FR-RTL-03)", async () => {
    // The refusal is about establishing connections, not about the ones that
    // exist. A limiter that killed live sockets to enforce an establishment
    // limit would be enforcing a concurrency limit, which is a different
    // promise and one Relay has not made.
    harness = await boot(
      stubApi(),
      undefined,
      undefined,
      undefined,
      stubLimits({ connect: 1 }),
    );
    const open = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(open, "connection.ack");

    const refused = new WebSocket(`${harness.url}?token=${await token()}`);
    expect((await unexpectedResponse(refused)).status).toBe(429);

    // Still there, and still working — a round trip rather than a readyState
    // check, because "the socket object says OPEN" is not the same claim.
    open.send(
      JSON.stringify({
        type: "message.send",
        payload: { channel: CHANNEL, text: "hello", idem_key: "k1" },
      }),
    );
    expect(await nextFrame(open, "message.ack")).toMatchObject({
      payload: { seq: 42 },
    });
    open.close();
  });

  it("answers an over-limit frame with rate_limited and KEEPS THE CONNECTION OPEN", async () => {
    harness = await boot(
      stubApi(),
      undefined,
      undefined,
      undefined,
      stubLimits({ send: 1 }),
    );
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(socket, "connection.ack");
    const send = () =>
      socket.send(
        JSON.stringify({
          type: "message.send",
          payload: { channel: CHANNEL, text: "hello", idem_key: "k1" },
        }),
      );

    send();
    await nextFrame(socket, "message.ack");
    send();
    const error = await nextFrame(socket, "error");
    // `rate_limited` was declared in chapter 1.3 and emitted by nothing until
    // now. This is the first line of the codebase that sends it.
    expect(error).toMatchObject({ payload: { code: "rate_limited" } });
    // And every error frame carries an id now, which is the other contract
    // chapter 1.3 wrote down and never wired.
    expect((error as { payload: { request_id: string } }).payload.request_id)
      .toBeTruthy();

    // THE POINT: the socket is still up. Closing it would make the client
    // reconnect, and a reconnect spends the ESTABLISHMENT allowance — a
    // limiter that pushes the limited into a second limit.
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("enforces a CONFIGURED connect limit, not just the default (ADR-05, FR-RTL-04)", async () => {
    // The limit arrives on the authentication response, because the gateway has
    // no database to read it from. A test that only exercised the default would
    // pass with the plumbing missing entirely.
    harness = await boot(
      stubApi({
        session: async () => ({
          environment_id: "env-1",
          user: "tuan",
          // Chapter 3.15: the api now reports whether the user is banned, and a stub
          // that does not say is a stub that has not thought about it.
          banned: false,
          channel_ids: [CHANNEL],
          limits: { connect: 2, send: 600 },
        }),
      }),
      undefined,
      undefined,
      undefined,
      // No allowance override: the stub honours the limit the session response
      // carried, so the number under test is the CONFIGURED one.
      stubLimits(),
    );
    const first = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(first, "connection.ack");
    const second = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(second, "connection.ack");

    const third = new WebSocket(`${harness.url}?token=${await token()}`);
    expect((await unexpectedResponse(third)).status).toBe(429);
    first.close();
    second.close();
  });

  it("does not apply a limit changed mid-connection until the client reconnects (research R12)", async () => {
    // The consequence R12 accepted, asserted so it is a property rather than a
    // surprise. The alternative is a Postgres read per frame, from a service
    // that holds no database client, on the hot path of the thing the limit
    // protects.
    let configured = 600;
    harness = await boot(
      stubApi({
        session: async () => ({
          environment_id: "env-1",
          user: "tuan",
          // Chapter 3.15: the api now reports whether the user is banned, and a stub
          // that does not say is a stub that has not thought about it.
          banned: false,
          channel_ids: [CHANNEL],
          limits: { connect: 3_000, send: configured },
        }),
      }),
      undefined,
      undefined,
      undefined,
      stubLimits(),
    );
    const socket = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(socket, "connection.ack");

    // The policy changes to "refuse everything" while the socket is open.
    configured = 0;

    socket.send(
      JSON.stringify({
        type: "message.send",
        payload: { channel: CHANNEL, text: "hello", idem_key: "k1" },
      }),
    );
    // Still allowed: this connection is spending the allowance it was born
    // with. A new one would not be.
    expect(await nextFrame(socket, "message.ack")).toMatchObject({
      payload: { seq: 42 },
    });

    const reconnected = new WebSocket(`${harness.url}?token=${await token()}`);
    await nextFrame(reconnected, "connection.ack");
    reconnected.send(
      JSON.stringify({
        type: "message.send",
        payload: { channel: CHANNEL, text: "hello", idem_key: "k1" },
      }),
    );
    expect(await nextFrame(reconnected, "error")).toMatchObject({
      payload: { code: "rate_limited" },
    });

    socket.close();
    reconnected.close();
  });

  it("emits 4008 for a quota, and 4009 from nowhere (chapter 3.11)", async () => {
    // CHAPTER 3.8 WROTE THIS TEST INVERTED, and said why:
    //
    //   4008 reads "quota exhausted". There is no quota yet — quotas are a
    //   later chapter — and reaching for the code because it was declared would
    //   collapse the distinction this chapter is built on: a rate limit is a
    //   smoothing instruction, a quota is a commercial one, and they do not
    //   deserve the same signal.
    //
    // This is the later chapter. The distinction it was protecting survives and
    // is now visible on the wire rather than asserted in a comment: a rate limit
    // refuses the handshake with a raw 429 and a `Retry-After`, and a quota
    // COMPLETES the handshake, sends an error frame carrying the resume date, and
    // closes 4008. Two refusals at one door, and a client can tell them apart.
    //
    // 4009 IS STILL EMITTED BY NOTHING. Chapter 3.11 gave the gateway its first
    // shutdown path, so "server shutdown (drain)" is closer than it has ever
    // been — and draining is a feature with its own semantics rather than a code
    // to reach for because a handler arrived.
    //
    // Grep rather than behaviour, because half the claim is about ABSENCE: no
    // input makes this service send 4009, and the only way to check "no input"
    // is to read what the source can send.
    const source = await Promise.all(
      ["session.ts", "limits.ts", "resume.ts", "main.ts", "meter.ts"].map((file) =>
        readFile(new URL(file, import.meta.url), "utf8"),
      ),
    );
    const joined = source.join("");

    expect(joined).toMatch(/close\(\s*4008/);
    for (const text of source) {
      expect(text).not.toMatch(/close\(\s*4009/);
    }
    // A grep that can only pass is not a check — the same pattern, aimed at a
    // code this file does emit, has to match.
    expect(joined).toMatch(/close\(\s*400[12]/);
    // And the vocabulary still declares both, so 4009 is "unused", not "gone".
    expect(CLOSE_CODES[4008]).toBeDefined();
    expect(CLOSE_CODES[4009]).toBeDefined();
  });
});

// T038. THE INBOUND SET, ASSERTED BY SIZE AND BY MEMBERSHIP.
//
// For twenty chapters this was one string literal in one `!==`, and nothing said
// how many inbound frames there were because one is not a number anybody writes
// down. Widening it to a set is what makes the count a fact, and a fact is what a
// test can hold.
//
// `codes.test.ts` is the precedent: it asserts the exact close-code set AND the
// exact count, which is what makes a seventeenth code a decision rather than an
// accident. The same argument applies harder here — **the inbound seam is where a
// protocol is attacked**, and a third member arriving unnoticed is the failure
// this file exists to prevent.
describe("INBOUND_FRAME_TYPES (chapter 3.21)", () => {
  it("has exactly two members", () => {
    expect(INBOUND_FRAME_TYPES.size).toBe(2);
  });

  it("is exactly message.send and typing.send", () => {
    expect([...INBOUND_FRAME_TYPES].sort()).toEqual([
      "message.send",
      "typing.send",
    ]);
  });

  it("holds no server-to-client type, checked against the ones that matter", () => {
    // Not a restatement of the test above. That one pins the set; this one says
    // WHY the pin matters, in the vocabulary of the frames a forger would reach
    // for first — an ack a client could fake, and the outbound `typing` a client
    // could use to type as somebody else.
    for (const forgeable of ["message.ack", "message.created", "typing"]) {
      expect(INBOUND_FRAME_TYPES.has(forgeable as never)).toBe(false);
    }
  });
});
