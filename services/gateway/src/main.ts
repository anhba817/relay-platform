import { CLOSE_CODES, frameSchema } from "@relay/protocol";
import { createLogger, serve, type Logger } from "@relay/service-kit";

// The gateway — SAD §4.1: terminates WebSockets and never writes to the
// database (ADR-05). At walking-skeleton stage no sockets exist yet; instead
// the gateway DECLARES the wire vocabulary it will speak, computed from
// @relay/protocol — never hardcoded, so the advertisement cannot drift from
// the contract. Sessions, JWT verification, and real frames arrive in Part 2.

const frames = frameSchema.options.map((option) => option.shape.type.value);
const closeCodes = Object.keys(CLOSE_CODES).map(Number);

export function createServer(logger?: Logger) {
  return serve({
    service: "gateway",
    health: () => ({
      uptime_s: Math.round(process.uptime()),
      protocol: { frames, close_codes: closeCodes },
    }),
    ...(logger ? { logger } : {}),
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4001);
  const logger = createLogger("gateway");
  createServer().listen(port, () => {
    logger.log("info", "listening", { port });
  });
}
