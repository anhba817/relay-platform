import { CLOSE_CODES, docsUrl, frameSchema } from "@relay/protocol";
import { createLogger, serve, type Logger } from "@relay/service-kit";

import { createApiClient } from "./api-client.js";
import { createFanout } from "./fanout.js";
import { createMembership } from "./membership.js";
import { createPresence } from "./presence.js";
import { createConnections } from "./connections.js";
import { createTyping } from "./typing.js";
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
      notFoundDocsUrl: docsUrl("not_found"),
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
  // THE THIRD AND FOURTH REDIS CLIENTS, and the reason is the fan-out's verbatim: a
  // connection in subscribe mode cannot run `SET` or `EXISTS`, so presence needs a
  // subscriber and a command client of its own. Created here rather than inside
  // `attachSessions` so the tests that call that function directly stay Redis-free,
  // and so its close has an owner.
  const presence = createPresence({ logger: log });
  // THE FIFTH REDIS CLIENT, and only one where presence needed two: this module
  // subscribes and never runs a command, so there is nothing a subscriber-mode
  // connection would refuse. Created here rather than inside `attachSessions` so the
  // tests that call that function directly stay Redis-free, and so its close has an
  // owner.
  const membership = createMembership({ logger: log });
  // THE SIXTH AND SEVENTH REDIS CLIENTS, and this module needs two of its own — a
  // publisher and a subscriber — because it is the first fabric this service both
  // publishes to and consumes from. `fanout.ts` states why they cannot be one client:
  // a subscribed connection cannot issue ordinary commands, and PUBLISH is one.
  const typing = createTyping({ logger: log });
  // The connection registry's own client. Its keys put the environment id FIRST —
  // `conn:{env}:{user}:{slot}` — so a cross-tenant read would need a caller to hand
  // this module another environment's id, which the session layer takes from the
  // api's verified identity and never from a payload.
  const connections = createConnections({ logger: log });
  // THE NINTH REDIS CLIENT, AND THE FIRST THAT ONLY COUNTS. Not one of fanout's
  // two: one of those is a subscriber, and a connection in subscribe mode cannot run
  // `INCR`. Created here rather than inside `attachSessions` so the tests that call
  // that function directly stay Redis-free, and so its close has an owner.
  const limits = createGatewayLimits();
  // THE FIRST SECRET THIS SERVICE HAS EVER HELD, and it is not a
  // signing secret: the credentials chapter's claim that "the gateway holds no signing
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
    presence,
    membership,
    typing,
    // AND THIS LINE IS WHAT `main.test.ts` GUARDS. Without it the cap does nothing:
    // `connections?.claim(...)` is an optional chain on `undefined`, so every socket
    // is admitted and no number moves — `**/main.ts` is excluded from the coverage
    // ratchet, so no figure could show it. Registering `close()` below is the other
    // half and neither substitutes for the other: without this line the cap is inert,
    // without that one every gateway leaks a Redis client.
    connections,
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
    // `server.on("close")` has nowhere to await, so the teardown that MUST be waited
    // for is handed back as `shutdown()` instead. The listener stays for the paths
    // that close the server without leaving the process — tests, mostly — and the
    // signal handler below awaits the same work before exiting.
    void shutdown();
  });
  /** Everything this process holds, awaited in the order that matters.
   *
   * SEVEN, NOT THREE. Published's gateway held `sessions`, `fanout` and `limits` at
   * this chapter; this one reaches it holding four more, and every one of them owns a
   * Redis client. A `shutdown` that closed three of seven would leak four per deploy —
   * and `main.ts` is excluded from the coverage ratchet, so no figure could show it.
   *
   * `sessions` FIRST, because its close is the one with work to finish: a final usage
   * report and the release of the places this instance holds. The fabrics it reports
   * and publishes through have to still be open while it does that. */
  async function shutdown(): Promise<void> {
    await sessions.close();
    await fanout.close();
    await presence.close();
    await membership.close();
    await typing.close();
    await connections.close();
    await limits.close();
  }
  return Object.assign(server, { shutdown });
}

if (import.meta.main) {
  const requested = Number(process.env.PORT ?? 4001);
  const logger = createLogger("gateway");
  const server = createServer(logger);
  server.listen(requested, () => {
    // THE PORT IT GOT, NOT THE PORT IT ASKED FOR — the same fix the api carries, and
    // for eleven chapters only the api carried it.
    //
    // `PORT=0` asks the operating system for a free port, which is what a test
    // spawning a service should do. But a parent can only use the number if the
    // child reports it, and logging `requested` prints 0. The api reads the bound
    // address back; this did not, so `PORT=0` was safe for one of the two services
    // and nothing said which. The e2e journey found it by asking: `api up on 37763`,
    // then `gateway 1 never became healthy` — a health probe against port zero.
    //
    // NOTHING NOTICED BECAUSE NOTHING ASKED. Every suite that spawned a gateway used
    // a fixed port, so the logged value was always the value it had passed in and
    // always correct by accident.
    const address = server.address() as { port?: number } | string | null;
    const port =
      typeof address === "object" && address !== null ? (address.port ?? requested) : requested;
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
  // the rate-limit chapter refused by name.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.log("info", "shutdown.signal", { signal });
      server.close();
      void server.shutdown().then(() => process.exit(0));
    });
  }
}
