import { CLOSE_CODES, frameSchema } from "@relay/protocol";
import { createLogger, serve, type Logger } from "@relay/service-kit";

import { createApiClient } from "./api-client.js";
import { createFanout } from "./fanout.js";
import { createGatewayLimits } from "./limits.js";
import { attachSessions } from "./session.js";

// The gateway — SAD §4.1: terminates WebSockets and never writes to the
// database (ADR-05). Chapter 1.4 stood up the HTTP half (health, request
// ids, structured logs); chapter 2.5 gives it the job it exists for, and
// 2.6 makes that job survive a second instance. The
// health payload still advertises the wire vocabulary, computed from
// @relay/protocol so the advertisement cannot drift from the contract.

const frames = frameSchema.options.map((option) => option.shape.type.value);
const closeCodes = Object.keys(CLOSE_CODES).map(Number);

export const DEFAULT_API_URL = "http://localhost:4000";

export function createServer(logger?: Logger) {
  const log = logger ?? createLogger("gateway");
  const server = serve({
    service: "gateway",
    health: () => ({
      uptime_s: Math.round(process.uptime()),
      protocol: { frames, close_codes: closeCodes },
    }),
    logger: log,
  });
  // The socket server rides the SAME listener as health — one port, two
  // protocols, which is what an upgrade handshake is for.
  // Every instance is both publisher and subscriber: there is no leader
  // here, and no instance knows how many others exist (ADR-07). Scaling
  // out is adding a process.
  const fanout = createFanout({ logger: log });
  // Chapter 3.8. A SECOND Redis client, not fanout's — one of fanout's two is a
  // subscriber, and a connection in subscribe mode cannot run `INCR`. It is
  // created here rather than inside `attachSessions` so the tests that call
  // that function directly stay Redis-free, and so its close has an owner.
  const limits = createGatewayLimits();
  // Chapter 3.11. THE FIRST SECRET THIS SERVICE HAS EVER HELD, and it is not a
  // signing secret: chapter 3.2's claim that "the gateway holds no signing
  // secret" is untouched, because this one verifies nothing and signs nothing.
  // It only says which service is talking, on the one call that is the
  // gateway's own rather than a user's.
  //
  // ABSENT BY DEFAULT AND NOT A STARTUP DEPENDENCY. A gateway with no credential
  // serves sockets and meters nothing, and says so once here rather than on
  // every tick — metering may not be able to refuse a connection (FR-012), and
  // the loudest version of that rule is that it cannot refuse a boot either.
  const serviceCredential = process.env.RELAY_INTERNAL_CREDENTIAL_GATEWAY;
  if (serviceCredential === undefined) {
    log.log("info", "metering.disabled", {
      reason: "RELAY_INTERNAL_CREDENTIAL_GATEWAY is not set",
    });
  }
  const sessions = attachSessions({
    server,
    api: createApiClient(
      process.env.RELAY_API_URL ?? DEFAULT_API_URL,
      serviceCredential,
    ),
    logger: log,
    fanout,
    limits,
  });
  server.on("close", () => {
    sessions.close();
    void fanout.close();
    void limits.close();
  });
  return server;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4001);
  const logger = createLogger("gateway");
  createServer(logger).listen(port, () => {
    logger.log("info", "listening", { port });
  });
}
