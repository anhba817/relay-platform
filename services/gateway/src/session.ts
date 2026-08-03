import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";

import { CLOSE_CODES, frameSchema, type Frame } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
import { WebSocketServer, type WebSocket } from "ws";

import type { ApiClient } from "./api-client.js";
import { verifyToken, type Identity } from "./auth.js";
import { Registry, type Connection } from "./registry.js";

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
  /** Overridable so tests can run the heartbeat in milliseconds instead of
   * half-minutes — the interval is a contract (EIR-WS-04), not a constant
   * the tests should have to wait out. */
  pingIntervalMs?: number;
}

export function attachSessions({
  server,
  api,
  logger,
  pingIntervalMs = PING_INTERVAL_MS,
}: SessionServerOptions): { registry: Registry; close: () => void } {
  const registry = new Registry();
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
        void open(ws, identity);
      });
    })();
  });

  async function open(socket: WebSocket, identity: Identity): Promise<void> {
    const connection: Connection = {
      id: randomUUID(),
      identity,
      socket,
      channelIds: new Set(),
      missedPings: 0,
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
    logger.log("info", "connection.opened", {
      connection_id: connection.id,
      user: identity.userExternalId,
      channels: connection.channelIds.size,
    });

    // EIR-WS-03: identity and a resume cursor within one second. The cursor
    // is empty here and means it for the first time in 2.7 — the field
    // exists because the contract says so, not because we have data for it.
    send(socket, {
      type: "connection.ack",
      payload: {
        user: identity.userExternalId,
        cursor: {},
        resume_ok: true,
        truncated: [],
      },
    });

    socket.on("pong", () => {
      connection.missedPings = 0;
    });
    socket.on("message", (raw) => void handle(connection, raw.toString()));
    socket.on("close", (code) => {
      registry.remove(connection.id);
      logger.log("info", "connection.closed", {
        connection_id: connection.id,
        code,
      });
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
      const { seq } = await api.sendMessage(connection.identity, {
        channel_id: channel,
        text,
        idempotency_key: idem_key,
      });
      // The ack carries the sequence the API committed — after the commit,
      // never before (FR-MSG-05, unchanged since 2.2; the socket is a new
      // door onto the same write path).
      send(connection.socket, { type: "message.ack", payload: { seq } });
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
