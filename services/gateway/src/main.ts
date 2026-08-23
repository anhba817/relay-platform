import { CLOSE_CODES, frameSchema, docsUrl } from "@relay/protocol";
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
    // The registry owns the URL; `service-kit` owns no dependencies. So the URL
    // crosses the boundary as data (chapter 3.12, FR-027, R9).
    notFoundDocsUrl: docsUrl("not_found"),
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
  // every tick — metering may not be able to refuse a connection (constitution III), and
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
    // Overridable so `meter.itest.ts` can drive a spawned gateway without
    // waiting a real minute per assertion. The two tests there are the ones an
    // in-process gateway cannot run — a signal has to arrive at a process — and
    // sixty seconds each would put them past the suite's timeout.
    //
    // Spread rather than assigned `undefined`: `exactOptionalPropertyTypes` is
    // on, and "absent" and "present but undefined" are different things to it.
    ...(process.env.RELAY_METER_INTERVAL_MS
      ? { meterIntervalMs: Number(process.env.RELAY_METER_INTERVAL_MS) }
      : {}),
  });
  // `server.on("close")` has nowhere to await, so the teardown that MUST be
  // waited for is handed back instead. The listener stays for the paths that
  // close the server without leaving the process — tests, mostly — and the
  // signal handler below awaits the same work before exiting.
  server.on("close", () => {
    void shutdown();
  });
  async function shutdown(): Promise<void> {
    await sessions.close();
    await fanout.close();
    await limits.close();
  }
  return Object.assign(server, { shutdown });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4001);
  const logger = createLogger("gateway");
  const server = createServer(logger).listen(port, () => {
    logger.log("info", "listening", { port });
  });

  // A GRACEFUL SHUTDOWN, WHICH THIS SERVICE DID NOT HAVE (research R11, FR-RTL-05).
  //
  // `serve()` returns a bare `node:http` Server, and nothing here ever called
  // `server.close()` — so the `server.on("close")` handler above, which four
  // documents said flushed a final usage report, ran on no path at all. On
  // `docker stop` the process took SIGTERM, Node's default disposition exited,
  // and the handler was never reached. Every document agreed with every other
  // document and none of them was the thing that had to be true.
  //
  // AWAITED, not fired. A flush that is not waited for is the same non-guarantee
  // one line further down: the process leaves before the request does. This is
  // the difference between losing a minute per crash and losing a minute per
  // deploy times every open socket, and a deploy is the frequent one.
  //
  // The shape is the dispatcher's, at `services/dispatcher/src/main.ts:313`.
  //
  // 4009 IS NOT EMITTED HERE. `CLOSE_CODES[4009]` reads "server shutdown
  // (drain)" and this is the first shutdown path the gateway has ever had, so
  // the code is sitting right there — but draining is telling clients to
  // reconnect elsewhere, which is a feature with its own semantics. Reaching for
  // it because a handler happened to arrive is the "declared, so use it" that
  // chapter 3.8 refused by name.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.log("info", "shutdown.signal", { signal });
      server.close();
      void server.shutdown().then(() => process.exit(0));
    });
  }
}
