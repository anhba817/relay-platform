import type { IncomingMessage, ServerResponse } from "node:http";

import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { newRequestId, type Logger } from "@relay/service-kit";

import { LOGGER } from "./logger";

// EIR-API-05 + NFR-OBS-06, unchanged from the frameworkless skeleton: every
// response carries X-Request-Id, every request logs exactly one structured
// line carrying the same id. Logging on `finish` (not on entry) is what
// keeps it to one line per request no matter which controller or filter
// ends up answering.
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  use(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const requestId = newRequestId();
    res.setHeader("X-Request-Id", requestId);
    res.on("finish", () => {
      this.logger.log("info", "request", {
        request_id: requestId,
        method: req.method,
        path: req.url,
        status: res.statusCode,
      });
    });
    next();
  }
}
