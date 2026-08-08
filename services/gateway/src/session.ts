import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";

import {
  CLOSE_CODES,
  frameSchema,
  type Frame,
  type Message,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
import { WebSocketServer, type WebSocket } from "ws";

import type { ApiClient } from "./api-client.js";
import { verifyToken, type Identity } from "./auth.js";
import type { Fanout } from "./fanout.js";
import { Registry, type Connection } from "./registry.js";
import {
  MAX_BUFFERED_FRAMES,
  SUBSCRIBE_DEADLINE_MS,
  flushable,
  highWaterMarks,
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
function sendError(socket: WebSocket, code: string, message: string): void {
  send(socket, {
    type: "error",
    payload: {
      code,
      message,
      docs_url: `https://relay.example/docs/errors/${code}`,
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
}

export function attachSessions({
  server,
  api,
  logger,
  fanout,
  pingIntervalMs = PING_INTERVAL_MS,
  resumeDeadlineMs = SUBSCRIBE_DEADLINE_MS,
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
      const identity = token ? await verifyToken(token) : null;
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (!identity) {
          // 4001: "invalid or expired token" (EIR-WS-05). The close code is
          // the protocol package's, not a number invented here.
          ws.close(4001, CLOSE_CODES[4001]);
          logger.log("info", "connection.rejected", { reason: "bad_token" });
          return;
        }
        void open(ws, identity, req.url ?? "/");
      });
    })();
  });

  async function open(
    socket: WebSocket,
    identity: Identity,
    url: string,
  ): Promise<void> {
    // Cursors are read BEFORE anything else, because their presence decides
    // whether this connection is born buffering or born live.
    const presented = parseCursors(url);
    const connection: Connection = {
      id: randomUUID(),
      identity,
      socket,
      channelIds: new Set(),
      missedPings: 0,
      phase: presented === undefined ? "live" : "buffering",
      buffer: [],
      overflowed: false,
    };
    try {
      connection.channelIds = new Set(await api.memberships(identity));
    } catch (error) {
      // The api is the only source of membership (ADR-05). If it cannot
      // answer, we do not guess — we close, and the client retries with
      // backoff. A session with unknown memberships would deliver nothing
      // and look healthy doing it.
      logger.log("error", "connection.memberships_failed", {
        connection_id: connection.id,
        error: String(error),
      });
      socket.close(1011, "membership lookup failed");
      return;
    }

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
