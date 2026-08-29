import { CLOSE_CODES, docsUrl, frameSchema } from "@relay/protocol";
import { createLogger, serve, type Logger } from "@relay/service-kit";

import { createApiClient } from "./api-client.js";
import { createFanout } from "./fanout.js";
import { createPresence } from "./presence.js";
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
  const sessions = attachSessions({
    server,
    api: createApiClient(process.env.RELAY_API_URL ?? DEFAULT_API_URL),
    logger: log,
    fanout,
    presence,
  });
  server.on("close", () => {
    sessions.close();
    void fanout.close();
    void presence.close();
  });
  return server;
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
}
