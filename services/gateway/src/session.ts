import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";

import {
  CLOSE_CODES,
  docsUrl,
  frameSchema,
  type ErrorCode,
  type Frame,
  type Message,
  isErrorCode,
  type PresenceFabric,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
import { WebSocketServer, type WebSocket } from "ws";

import { ApiError, type ApiClient } from "./api-client.js";
import { authenticate, type Identity } from "./auth.js";
import type { Fanout } from "./fanout.js";
import { type Presence } from "./presence.js";
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

/** EIR-API-04's envelope, wearing its WebSocket clothes. */
function sendError(socket: WebSocket, code: ErrorCode, message: string): void {
  send(socket, {
    type: "error",
    payload: {
      code,
      message,
      docs_url: docsUrl(code),
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
  /** Optional for the same reason `fanout` is: the socket chapter's tests and a
   * single-process dev run have no Redis, and a socket server that refused to start
   * without one would be a worse default than a presence-less one. `main.ts` always
   * supplies it, so the optionality is a test affordance rather than a deployment
   * mode. */
  presence?: Presence;
}

// THE FOUR PRESENCE TIMINGS ARE NOT HERE, and an earlier draft of this chapter put
// them here. `fanout` and `presence` are INJECTED already built, and an injected thing
// carries its own configuration: a test that wants a hundred-millisecond grace period
// constructs `createPresence({ graceMs: 100, … })` and injects that, the way the
// fan-out's tests already do. Four options that only forwarded values would be four
// more things to keep in step with `PresenceOptions`.
//
// eslint found this: they were declared, destructured, and used by nothing.
// `presence` itself is declared on the interface above and destructured below, where
// the delivery path and the two hook points consume it.

export function attachSessions({
  server,
  api,
  logger,
  fanout,
  pingIntervalMs = PING_INTERVAL_MS,
  resumeDeadlineMs = SUBSCRIBE_DEADLINE_MS,
  presence,
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
      // A live connection is not necessarily a connection with
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

  /** A presence transition arriving from its own fabric.
   *
   * NOT `deliver`'s path, and the differences are the point. Presence carries no
   * sequence, so it can neither duplicate a backfilled row nor leave a gap — which
   * is why it consults neither `connection.phase` nor `connection.marks`. Buffering
   * it during a resume would delay a frame for no benefit, and `suppressed()` takes
   * a `Message`. A transition mid-resume is sent immediately.
   *
   * THE WIRE FRAME IS BUILT FROM TWO FIELDS. `transition` is the fabric's business
   * and never leaves this function: what a client receives is what chapter 1.3
   * published and `frames.test.ts` asserts. */
  function deliverPresence(channelId: string, payload: PresenceFabric): void {
    for (const connection of registry.subscribersOf(channelId)) {
      // One frame per transition per connection, however many channels this
      // connection shares with the subject (FR-012).
      if (!presence?.claim(payload.transition, connection.id)) continue;
      send(connection.socket, {
        type: "presence.changed",
        payload: { user: payload.user, state: payload.state },
      });
    }
  }
  presence?.onTransition(deliverPresence);
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
      // The api verifies, and answers with the identity AND the
      // memberships. This is the same one call the connect path already made —
      // it just asks a better question than "what may this user hear".
      const result = await authenticate(api, token);
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
        if (result.outcome === "banned") {
          // FR-031. THE SHAPE OF THE QUOTA REFUSAL, for the same reason:
          // the handshake completes so a close code has a socket to arrive on, and an
          // error frame goes first because a close reason is a short string.
          //
          // 4003 AND NOT 4001. The token is valid; the user is refused. Closing 4001
          // would send a client round the re-authentication loop for ever, which is the
          // argument `codes.ts` makes for having distinct codes at all.
          sendError(
            ws,
            "user_banned",
            "this user is banned in this environment and cannot connect",
          );
          ws.close(4003, CLOSE_CODES[4003]);
          logger.log("info", "connection.rejected", { reason: "user_banned" });
          return;
        }
        // NO SEND LIMIT ARGUMENT YET. `authenticate` returns the limits with the
        // session in movement VII, where the limiter is written; `open` takes four
        // parameters until then rather than a fifth nothing can supply.
        void open(ws, result.identity, result.channelIds, req.url ?? "/");
      });
    })();
  });

  async function open(
    socket: WebSocket,
    identity: Identity,
    channelIds: string[],
    url: string,
  ): Promise<void> {
    // Cursors are read BEFORE anything else, because their presence decides
    // whether this connection is born buffering or born live.
    const presented = parseCursors(url);
    const connection: Connection = {
      id: randomUUID(),
      identity,
      socket,
      // Memberships arrived with the identity, from the session
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
    };

    registry.add(connection);
    // Subscriptions follow membership: the first local member of a channel
    // makes this instance a subscriber, and the last one to leave releases
    // it (reference-counted in the fabric).
    const subscribing = Promise.all(
      [...connection.channelIds].flatMap((channelId) => [
        fanout?.subscribe(channelId),
        // Presence has its own subject per channel, so a channel now
        // carries two subscriptions. `ioredis` takes a variadic `subscribe`, so the
        // count doubles and the round trips do not.
        presence?.subscribe(channelId),
      ]),
    );
    // AFTER `registry.add`, so "is this the user's first connection here?" is asked
    // of a registry that already contains it. The close handler needs the opposite
    // and gets it three lines apart — see the note there.
    void presence?.connected(
      identity.environmentId,
      identity.userExternalId,
      connection.channelIds,
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
      // THIS HANDLER NOW CARRIES TWO ORDERING CONSTRAINTS, not none. Presence is told
      // AFTER `registry.remove`, because it asks whether this was the user's last
      // connection on this instance and must not count the one that is leaving. The
      // unsubscribes come last.
      //
      // The first of those is not a style change. With `registry.remove` after this
      // block, `connectionsFor` still sees the closing connection, the count is 1
      // rather than 0, no grace check is ever scheduled, and the user stays online for
      // ever. A test asserts the scheduling for that reason.
      //
      // The condition asks a local question only. Closing one of two connections on
      // this instance must publish nothing (FR-006); whether the user is still
      // connected on some OTHER instance is Redis's to answer, and this registry has
      // been unable to see other instances since 2.5.
      if (
        registry.connectionsFor(connection.identity.userExternalId).length === 0
      ) {
        void presence?.disconnected(
          connection.identity.environmentId,
          connection.identity.userExternalId,
          connection.channelIds,
        );
      }
      // Releasing a subscription can fail — a broker that went away, or a
      // fabric already closed while sockets were still draining — and a
      // close handler is the last place that should throw. The subscribe
      // path has said this since 2.7; the release path had not, and an
      // unhandled rejection during teardown is how chapter 2.8's lane found
      // out. Nothing to recover: the connection is gone either way.
      void Promise.all(
        [...connection.channelIds].flatMap((channelId) => [
          fanout?.unsubscribe(channelId).catch((error: unknown) => {
            logger.log("error", "fanout.unsubscribe_failed", {
              channel: channelId,
              error: String(error),
            });
          }),
          // Inside the same swallowing wrapper, because a close handler is the last
          // place that should throw — chapter 2.8's lane found the unhandled
          // rejection on the fan-out's release path for exactly this reason.
          presence?.unsubscribe(channelId).catch((error: unknown) => {
            logger.log("error", "presence.failed", {
              op: "unsubscribe",
              channel: channelId,
              error: String(error),
            });
          }),
        ]),
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
      // A 401 here means the token this connection was opened
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
      // ── THE API'S OWN REFUSAL, FORWARDED ───────────────────────────────────
      //
      // A 4xx from the api is a fact about this request, and the api already named it:
      // `user_banned` for a banned sender, `channel_archived` for a closed channel,
      // `not_a_member`, `invalid_request`. Flattening those to `internal_error` told a
      // client to retry something that will never succeed, and hid two of this feature's
      // own refusals behind "send failed".
      //
      // ONLY 4xx, AND ONLY A REGISTERED CODE. A 5xx is not the client's business and its
      // body is not a contract; an unregistered string would put a code on the wire that
      // `codes.ts` does not define, which is the thing the error-registry chapter's registry exists to
      // prevent. Anything that fails either test stays `internal_error`.
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.code !== undefined &&
        isErrorCode(error.code)
      ) {
        sendError(
          connection.socket,
          error.code,
          error.publicMessage ?? "the request was refused",
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
