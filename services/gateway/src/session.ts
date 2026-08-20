import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  CLOSE_CODES,
  frameSchema,
  type Frame,
  type Message,
} from "@relay/protocol";
import { newRequestId, type Logger } from "@relay/service-kit";
import { WebSocketServer, type WebSocket } from "ws";

import { ApiError, type ApiClient } from "./api-client.js";
import { authenticate, type Identity } from "./auth.js";
import type { Fanout } from "./fanout.js";
import type { Decision, GatewayLimits } from "./limits.js";
import { Registry, type Connection } from "./registry.js";
import {
  MAX_BUFFERED_FRAMES,
  SUBSCRIBE_DEADLINE_MS,
  flushable,
  highWaterMarks,
  scopeMarks,
  suppressed,
  parseCursors,
  scopeCursors,
  withDeadline,
} from "./resume.js";

// One session per socket (chapter 2.5). The order of operations here is the
// chapter: verify at the door, learn memberships, register, ack inside
// EIR-WS-03's one-second budget, then start the heartbeat. Frames in are
// parsed with @relay/protocol's schemas — the SAME objects the api uses, so
// a frame the gateway accepts is a frame every component understands.

const PING_INTERVAL_MS = 30_000;
const MAX_MISSED_PINGS = 2;

function send(socket: WebSocket, frame: Frame): void {
  socket.send(JSON.stringify(frame));
}

/** EIR-API-04's envelope, wearing its WebSocket clothes.
 *
 * `request_id` ARRIVED IN CHAPTER 3.8, and the gateway had none to give — it
 * minted no ids at all. The field is required on the frame rather than optional,
 * because an optional fourth field would have been the fourth instance of the
 * habit that chapter is about: `rate_limited`, close code 4008 and this field
 * were all declared in 1.3 and left unenforced (research R13).
 *
 * WHAT THE ID IS FOR decides its shape. A developer quoting one in a support
 * ticket needs it to find a single server-side log line, and on a socket the
 * useful unit is the frame that failed — a client whose tenth `message.send` was
 * refused needs to point at that refusal, not at the connection. So callers pass
 * the id of the frame they are answering, and `sendError` mints one only for a
 * frame nobody asked for. */
/** The handshake refusal (chapter 3.8, FR-005). Written onto the raw upgrade
 * socket by hand, because there is no `res` here — `server.on("upgrade")` hands
 * over the socket and the unparsed head, and anything sent on it has to be a
 * complete HTTP response including the blank line before the body.
 *
 * The same three headers the api sends on a 429, from the same numbers, plus
 * `Retry-After` — a client should not have to learn a second dialect for the
 * socket door. `Connection: close` because this socket is not becoming a
 * WebSocket and is not being kept alive for a second request either. */
function refuseUpgrade(socket: Duplex, decision: Decision): void {
  const body = JSON.stringify({
    code: "rate_limited",
    message: "too many connections; retry after the window resets",
    docs_url: "https://relay.example/docs/errors/rate_limited",
    request_id: newRequestId(),
  });
  socket.write(
    [
      "HTTP/1.1 429 Too Many Requests",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      `Retry-After: ${decision.retryAfterSeconds}`,
      `X-RateLimit-Limit: ${decision.limit}`,
      `X-RateLimit-Remaining: ${decision.remaining}`,
      `X-RateLimit-Reset: ${decision.resetSeconds}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
  socket.destroy();
}

function sendError(
  socket: WebSocket,
  code: string,
  message: string,
  requestId: string = newRequestId(),
): void {
  send(socket, {
    type: "error",
    payload: {
      code,
      message,
      docs_url: `https://relay.example/docs/errors/${code}`,
      request_id: requestId,
    },
  });
}

export interface SessionServerOptions {
  server: Server;
  api: ApiClient;
  logger: Logger;
  /** The cross-instance fabric (chapter 2.6). Optional so 2.5's tests —
   * and a single-instance dev run — still work without Redis; when it is
   * absent, delivery is local-only, which is exactly the split brain this
   * chapter opened with. */
  fanout?: Fanout;
  /** Overridable so tests can run the heartbeat in milliseconds instead of
   * half-minutes — the interval is a contract (EIR-WS-04), not a constant
   * the tests should have to wait out. */
  pingIntervalMs?: number;
  /** Same reasoning for the resume path's patience with the fabric
   * (chapter 2.7): the degrade branch is a contract, and a test should not
   * have to sit through half a second to see it. */
  resumeDeadlineMs?: number;
  /** The shared counter (chapter 3.8). Optional for the same reason `fanout`
   * is: 2.5's tests and a single-process dev run have no Redis, and a socket
   * server that refused to start without one would be a worse default than an
   * uncounted one. `main.ts` always supplies it, so the optionality is a test
   * affordance rather than a deployment mode. */
  limits?: GatewayLimits;
}

export function attachSessions({
  server,
  api,
  logger,
  fanout,
  pingIntervalMs = PING_INTERVAL_MS,
  resumeDeadlineMs = SUBSCRIBE_DEADLINE_MS,
  limits,
}: SessionServerOptions): { registry: Registry; close: () => void } {
  const registry = new Registry();

  /** A frame arriving from the fabric — born on this instance or another,
   * indistinguishable by design — becomes message.created for every local
   * member of its channel. */
  function deliver(channelId: string, message: Message): void {
    for (const connection of registry.subscribersOf(channelId)) {
      if (connection.phase === "buffering") {
        // Step 2 (chapter 2.7). The frame is NOT dropped and NOT sent: it
        // waits until the backfill has had its turn, because sending it now
        // risks a duplicate and dropping it risks a gap.
        if (connection.buffer.length >= MAX_BUFFERED_FRAMES) {
          connection.overflowed = true;
          continue;
        }
        connection.buffer.push(message);
        continue;
      }
      // Chapter 3.7. A live connection is not necessarily a connection with
      // nothing to remember: a frame at or below what its backfill already
      // delivered is one it has, however long ago the resume finished. Before
      // this, delivery consulted `phase` and nothing else, and the marks were
      // discarded the moment the connection went live — which is precisely when
      // the fabric could still be catching up.
      if (suppressed(connection.marks, message)) continue;
      send(connection.socket, { type: "message.created", payload: message });
    }
  }
  fanout?.onDelivery(deliver);
  // noServer: the upgrade is handled by hand so the token can be checked
  // BEFORE the handshake completes. Letting ws own the upgrade would mean
  // rejecting a socket that already exists (EIR-WS-05 wants the close code
  // on a connection we never really opened).
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/ws") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token");
    void (async () => {
      // Chapter 3.2: the api verifies, and answers with the identity AND the
      // memberships. This is the same one call the connect path already made —
      // it just asks a better question than "what may this user hear".
      const result = await authenticate(api, token);
      // Chapter 3.8. THE ESTABLISHMENT LIMIT IS SPENT HERE, before
      // `handleUpgrade`, and that placement is the whole difference between
      // this refusal and the one below it.
      //
      // A refusal needs to say WHEN to come back. `Retry-After` is an HTTP
      // header and a close frame has nowhere to put one — a close code and a
      // short reason string is all the protocol offers, and "4008, try later"
      // is not an instruction a client can schedule against. So an over-limit
      // handshake is refused with an HTTP 429 on the upgrade request, which
      // still has a response to write headers onto (research R7).
      //
      // That makes it deliberately unlike the 4001 path immediately below,
      // which COMPLETES the handshake in order to close it — because EIR-WS-05
      // asks for a close code on a bad token, and a close code needs a socket
      // to arrive on. Two refusals, two shapes, each because of what it has to
      // carry.
      //
      // AFTER authentication, not before: the limit belongs to an environment
      // and nothing knows which environment this is until the api has said so.
      // The cost is that an unauthenticated flood still reaches the api — which
      // is what the auth limiter there is for, and why that one counts by
      // source address instead.
      if (result.outcome === "ok" && limits !== undefined) {
        const decision = await limits.spend(
          result.identity.environmentId,
          "connect",
          result.limits.connect,
        );
        if (decision.over) {
          refuseUpgrade(socket, decision);
          logger.log("info", "connection.rejected", {
            reason: "rate_limited",
            environment_id: result.identity.environmentId,
          });
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (result.outcome === "refused") {
          // 4001: "invalid or expired token" (EIR-WS-05). The close code is
          // the protocol package's, not a number invented here.
          ws.close(4001, CLOSE_CODES[4001]);
          logger.log("info", "connection.rejected", { reason: "bad_token" });
          return;
        }
        if (result.outcome === "unavailable") {
          // The api could not answer. Not the client's fault, so not 4001:
          // 1011 tells it to retry, which is the honest instruction (the same
          // distinction 2.5 drew for the memberships lookup).
          ws.close(1011, "session lookup failed");
          logger.log("error", "connection.session_failed", {
            error: result.error,
          });
          return;
        }
        void open(
          ws,
          result.identity,
          result.channelIds,
          req.url ?? "/",
          result.limits.send,
        );
      });
    })();
  });

  async function open(
    socket: WebSocket,
    identity: Identity,
    channelIds: string[],
    url: string,
    sendLimit: number,
  ): Promise<void> {
    // Cursors are read BEFORE anything else, because their presence decides
    // whether this connection is born buffering or born live.
    const presented = parseCursors(url);
    const connection: Connection = {
      id: randomUUID(),
      identity,
      socket,
      // Chapter 3.2: memberships arrived with the identity, from the session
      // call at the door. There is no second lookup to fail here — the api is
      // still the only source of membership (ADR-05), it just answers both
      // questions at once, and a failure now closes the socket before it opens.
      channelIds: new Set(channelIds),
      missedPings: 0,
      phase: presented === undefined ? "live" : "buffering",
      buffer: [],
      overflowed: false,
      // A fresh connect suppresses nothing; a resume fills this in when it
      // succeeds, and leaves it null when it degrades.
      marks: null,
      sendLimit,
    };

    registry.add(connection);
    // Subscriptions follow membership: the first local member of a channel
    // makes this instance a subscriber, and the last one to leave releases
    // it (reference-counted in the fabric).
    const subscribing = Promise.all(
      [...connection.channelIds].map((channelId) =>
        fanout?.subscribe(channelId),
      ),
    );
    logger.log("info", "connection.opened", {
      connection_id: connection.id,
      user: identity.userExternalId,
      channels: connection.channelIds.size,
      resuming: presented !== undefined,
    });

    // Listeners go on BEFORE the resume, not after the ack. A resume takes
    // a round trip to the api, and a socket that dies inside that window
    // must still be removed from the registry and release its subscriptions
    // — otherwise a client that reconnects impatiently leaks an instance's
    // worth of state per attempt.
    socket.on("pong", () => {
      connection.missedPings = 0;
    });
    socket.on("message", (raw) => void handle(connection, raw.toString()));
    socket.on("close", (code) => {
      registry.remove(connection.id);
      // Releasing a subscription can fail — a broker that went away, or a
      // fabric already closed while sockets were still draining — and a
      // close handler is the last place that should throw. The subscribe
      // path has said this since 2.7; the release path had not, and an
      // unhandled rejection during teardown is how chapter 2.8's lane found
      // out. Nothing to recover: the connection is gone either way.
      void Promise.all(
        [...connection.channelIds].map((channelId) =>
          fanout?.unsubscribe(channelId).catch((error: unknown) => {
            logger.log("error", "fanout.unsubscribe_failed", {
              channel: channelId,
              error: String(error),
            });
          }),
        ),
      );
      logger.log("info", "connection.closed", {
        connection_id: connection.id,
        code,
      });
    });

    if (presented === undefined) {
      // A FRESH connect, and 2.6's rule stands unchanged: never wait on the
      // fabric here. EIR-WS-03 gives the handshake one second, and a stopped
      // broker must cost delivery, not connections.
      void subscribing.catch((error: unknown) => {
        logger.log("error", "fanout.subscribe_failed", {
          connection_id: connection.id,
          error: String(error),
        });
      });
      ack(connection, { cursor: {}, resume_ok: true, truncated: [] });
      return;
    }
    await resume(connection, presented, subscribing);
  }

  /** EIR-WS-03's ack. `cursor` echoes what the server ACCEPTED, never the
   * post-backfill high-water mark: this frame goes out BEFORE the backfilled
   * frames, so advertising a position the client has not received yet is how
   * you manufacture the gap this chapter exists to close. */
  function ack(
    connection: Connection,
    payload: {
      cursor: Record<string, number>;
      resume_ok: boolean;
      truncated: string[];
    },
  ): void {
    send(connection.socket, {
      type: "connection.ack",
      payload: { user: connection.identity.userExternalId, ...payload },
    });
  }

  /** The five steps (chapter 2.7, SAD §5.2). Steps 1 and 2 already happened
   * — the connection was born `buffering` and the subscribes are in flight
   * — so what is left is: confirm, backfill, ack, emit, flush, live. */
  async function resume(
    connection: Connection,
    presented: Record<string, number> | null,
    subscribing: Promise<unknown>,
  ): Promise<void> {
    const cursors =
      presented === null ? {} : scopeCursors(presented, connection.channelIds);

    /** Everything that cannot promise completeness ends up here: the client
     * is told resume did not happen and which channels to page instead. The
     * frames held so far are dropped on purpose — they would be an arbitrary
     * fragment of a stream the client is about to refetch in full. */
    const degrade = (reason: string): void => {
      connection.buffer = [];
      // AND THE MARKS. A degraded resume tells the client to page history for
      // every channel, so the backfill behind these marks is a fragment or
      // nothing at all — suppressing on them would turn this chapter's duplicate
      // into a gap, which constitution II ranks worse.
      connection.marks = null;
      connection.phase = "live";
      ack(connection, {
        cursor: cursors,
        resume_ok: false,
        truncated: [...connection.channelIds],
      });
      logger.log("info", "resume.degraded", {
        connection_id: connection.id,
        reason,
      });
    };

    // A malformed cursor is not a closed connection. A client whose stored
    // cursor got corrupted can recover from `resume_ok: false` by paging
    // history; a client closed at the door can only reconnect and be closed
    // again. (2.4 answers a bad cursor with 400 because a REST caller can
    // read the error and change its mind mid-flight; a socket cannot.)
    if (presented === null) return degrade("malformed_cursor");

    // Step 1 must be TRUE, not merely started: a subscription that lands
    // after the backfill query leaves the window open. 2.6's rule survives
    // via the deadline — resume waits briefly and then degrades honestly
    // rather than hanging a handshake on a broker.
    if (!(await withDeadline(subscribing, resumeDeadlineMs))) {
      return degrade("fabric_unconfirmed");
    }

    let backfilled: Awaited<ReturnType<ApiClient["backfill"]>>;
    try {
      // Step 3. Nothing is emitted yet — the ack has to carry the
      // truncation list, so the fetch comes first (EIR-WS-03's comment in
      // the protocol package has said so since 1.3).
      backfilled = await api.backfill(connection.identity, cursors);
    } catch (error) {
      logger.log("error", "resume.backfill_failed", {
        connection_id: connection.id,
        error: String(error),
      });
      return degrade("backfill_failed");
    }

    const marks = highWaterMarks(cursors, backfilled);
    const truncated = Object.entries(backfilled)
      .filter(([, page]) => page.truncated)
      .map(([channelId]) => channelId);
    // An overflowed buffer means live frames were dropped and we cannot say
    // which; the honest answer is the same one FR-RTM-04 gives for too much
    // backfill — page history instead of trusting the stream.
    if (connection.overflowed) return degrade("buffer_overflow");

    ack(connection, { cursor: cursors, resume_ok: true, truncated });

    for (const [, page] of Object.entries(backfilled)) {
      for (const message of page.messages) {
        send(connection.socket, {
          type: "message.created",
          payload: message,
        });
      }
    }

    // Step 4. Overflow between the ack and here cannot be reported in an
    // ack that already left, so the socket closes and the client resumes
    // again from the cursor it never advanced. (A channel busy enough to
    // overflow every attempt would loop; 7.5's load work is where that gets
    // measured rather than guessed.)
    if (connection.overflowed) {
      connection.socket.close(1011, "resume buffer overflow");
      return;
    }
    for (const message of flushable(connection.buffer, marks)) {
      send(connection.socket, { type: "message.created", payload: message });
    }
    connection.buffer = [];
    // KEPT, where chapter 2.7 discarded them. Scoped to the cursors this
    // connection actually presented, so the bound is this service's rather than
    // one inherited from the shape of the api's response.
    connection.marks = scopeMarks(marks, cursors);
    // Step 5.
    connection.phase = "live";
    logger.log("info", "resume.completed", {
      connection_id: connection.id,
      backfilled: Object.values(backfilled).reduce(
        (n, page) => n + page.messages.length,
        0,
      ),
      truncated: truncated.length,
    });
  }

  async function handle(connection: Connection, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(connection.socket, "invalid_frame", "frame is not JSON");
      return;
    }
    const frame = frameSchema.safeParse(parsed);
    if (!frame.success) {
      sendError(
        connection.socket,
        "invalid_frame",
        frame.error.issues[0]?.message ?? "frame failed schema validation",
      );
      return;
    }
    if (frame.data.type !== "message.send") {
      // Everything else in the union is server → client. A client uttering
      // one is a protocol violation, not a malformed frame (EIR-WS-06).
      sendError(
        connection.socket,
        "unknown_frame_type",
        `clients may not send ${frame.data.type}`,
      );
      connection.socket.close(4002, CLOSE_CODES[4002]);
      return;
    }

    // Chapter 3.8. THE SEND LIMIT IS SPENT ON THE FRAME, not on the api call
    // it becomes — a socket send and a REST send count against one budget
    // (FR-002), or a client could double its allowance by opening a socket.
    //
    // AND THE CONNECTION STAYS OPEN. Closing it would be the obvious move and
    // the wrong one: a closed socket makes the client reconnect, a reconnect
    // costs a handshake, and a handshake spends the ESTABLISHMENT allowance —
    // a limiter that punishes the limited into hitting a second limit. The
    // error frame says no to this frame and nothing more; the next one, after
    // the window turns over, goes through on the connection that is still there.
    //
    // The limit is the one this socket was born with (`connection.sendLimit`),
    // not one re-read per frame: the gateway has no database, and a Postgres
    // read on the hot path of the thing the limit protects would be a strange
    // way to protect it. A policy changed mid-connection reaches the client
    // when it reconnects (research R12).
    if (limits !== undefined) {
      const decision = await limits.spend(
        connection.identity.environmentId,
        "send",
        connection.sendLimit,
      );
      if (decision.over) {
        // `rate_limited` — declared in chapter 1.3, emitted here for the first
        // time. The numbers a 429 would carry in headers have nowhere to live
        // on a frame, so the retry window goes in the message text; the code is
        // what a client branches on.
        sendError(
          connection.socket,
          "rate_limited",
          `send rate limit exceeded; retry in ${decision.retryAfterSeconds}s`,
        );
        logger.log("info", "send.rate_limited", {
          connection_id: connection.id,
          environment_id: connection.identity.environmentId,
        });
        return;
      }
    }

    const { channel, text, idem_key } = frame.data.payload;
    try {
      const committed = await api.sendMessage(connection.identity, {
        channel_id: channel,
        text,
        idempotency_key: idem_key,
      });
      const { seq } = committed;
      // The ack carries the sequence the API committed — after the commit,
      // never before (FR-MSG-05, unchanged since 2.2; the socket is a new
      // door onto the same write path).
      send(connection.socket, { type: "message.ack", payload: { seq } });
      // …and only THEN does anyone else hear about it. Durability, then the
      // sender's confirmation, then everybody's copy: no step overtakes the
      // one before it (§5.1's ordering, now spanning machines).
      //
      // A RECOGNISED RETRY IS NOT REPUBLISHED. 2.3 made the retry safe for
      // storage; that did not make it safe for delivery, and a client that
      // retries on a flaky link would otherwise put the same message on
      // every member's screen twice. `text === null` is the same argument:
      // a tombstone recovered by an old key is not a creation.
      if (!committed.duplicate && committed.text !== null) {
        await fanout?.publish({
          id: committed.id,
          channel: committed.channel_id,
          seq: committed.seq,
          user: committed.user,
          text: committed.text,
          created_at: committed.created_at,
        });
      }
    } catch (error) {
      logger.log("error", "send.failed", {
        connection_id: connection.id,
        error: String(error),
      });
      // Chapter 3.2. A 401 here means the token this connection was opened
      // with has aged out: the socket is still up (FR-AUT-11 says expiry must
      // not terminate it) and still RECEIVES, because delivery never asks the
      // api anything. Writing does. Until FR-AUT-11's second clause exists — a
      // frame that lets a client hand over a refreshed token on the open
      // connection — the honest instruction is "reconnect", and saying so is
      // more useful than an "internal error" the client cannot act on.
      if (error instanceof ApiError && error.status === 401) {
        sendError(
          connection.socket,
          "unauthorized",
          "the token this connection was opened with has expired; " +
            "reconnect with a fresh one to send again",
        );
        return;
      }
      sendError(connection.socket, "internal_error", "send failed");
    }
  }

  const heartbeat = setInterval(() => {
    for (const connection of registry.all()) {
      if (connection.missedPings >= MAX_MISSED_PINGS) {
        // A dead socket that looks alive is a resume that never triggers
        // (EIR-WS-04). 2.7 needs death to be detected promptly.
        connection.socket.close(1001, "ping timeout");
        registry.remove(connection.id);
        continue;
      }
      connection.missedPings += 1;
      connection.socket.ping();
    }
  }, pingIntervalMs);

  return {
    registry,
    close: () => {
      clearInterval(heartbeat);
      wss.close();
    },
  };
}
