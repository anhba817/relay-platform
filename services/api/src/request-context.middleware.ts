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
    // ...and on the request, so a handler can put it in a line of its own.
    // Chapter 3.18 needed this: the fan-out publish logs its failure from inside
    // the send handler, and NFR-OBS-01 wants a request id in every structured
    // line while NFR-OBS-06 wants five-minute traceability from one. Until now
    // the id existed only here and on the response header, which a handler
    // cannot read without taking over the response.
    (req as { requestId?: string }).requestId = requestId;
    // `originalUrl` first, and this line was WRONG from chapter 2.2 until 3.8.
    // Express rewrites `req.url` relative to the mount point, and this middleware
    // is applied through `forRoutes("{*path}")`, so `req.url` is `/` — every
    // request this api has logged recorded `/` as its path. NFR-OBS-06 asks for
    // one structured line per request that an operator can grep; a line whose
    // path is always `/` is one they cannot.
    //
    // Found by probe while wiring the rate limiter, which reads the same value
    // to decide which routes it counts and would have counted nothing.
    const path =
      (req as { originalUrl?: string }).originalUrl ?? req.url ?? "/";
    res.on("finish", () => {
      this.logger.log("info", "request", {
        request_id: requestId,
        method: req.method,
        path,
        status: res.statusCode,
      });
    });
    next();
  }
}
