import type { IncomingMessage, ServerResponse } from "node:http";

import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { Logger } from "@relay/service-kit";

import type { RequestWithPrincipal } from "../auth/principal";
import { LOGGER } from "../logger";
import type { Publisher } from "../outbox/publisher";
import { ANALYTICS_PUBLISHER } from "../webhooks/analytics";
import {
  LIMITED_OPERATION,
  REFUSED_AT,
  publishRequest,
  type RefusedAt,
  type RequestFacts,
} from "./event";

// THIS IS REGISTERED SECOND, AND THE POSITION IS THE DESIGN.
//
// The chain is `RequestContext -> RequestLog -> Authenticate -> RateLimit`. Registering this
// LAST would have been the obvious reading of "after RequestContextMiddleware", and it would
// have lost exactly the requests a request log is opened to find: `RateLimitMiddleware`
// refuses a 429 with `res.statusCode = 429; res.end(...); return;` at two points and NEVER
// calls `next()`, so a middleware in position 4 is never reached at all.
//
// ATTACH EARLY, READ LATE. The listener's registration point and its read point are different
// moments, and the gap is what makes this work. Registered second it attaches before anything
// can short-circuit; when `finish` fires, `AuthenticateMiddleware` has already set
// `req.principal` if it ran and has not if the request never got that far. Both are correct
// records. Measured across a 200, an unauthenticated 200, a 429 and a 404: 4 of 4 captured.
//
// IT IS A SECOND MIDDLEWARE RATHER THAN A CHANGE TO THE FIRST. `RequestContextMiddleware`'s
// contract is one structured log line and an `X-Request-Id` header; it is cited by EIR-API-05
// and NFR-OBS-06 and it is fenced in the tutorial. Adding a broker publish to it would make
// an observability component depend on NATS.
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(ANALYTICS_PUBLISHER) private readonly analytics: Publisher,
  ) {}

  use(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    // R10's interval, and the contract states both ends: from here to the response's
    // `finish`. It EXCLUDES connection accept, TLS, request-body transfer and any middleware
    // registered before this one. NFR-PRF-02 takes the same posture with "excluding network",
    // and a duration compared against another duration measures the thing that changed only
    // if both use the same endpoints.
    const started = process.hrtime.bigint();

    res.on("finish", () => {
      const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      const r = req as IncomingMessage & RequestWithPrincipal & Record<symbol, unknown>;
      const route = (req as { route?: { path?: string } }).route;
      const baseUrl = (req as { baseUrl?: string }).baseUrl ?? "";

      // `req.route.path` IS THE WHOLE TEMPLATE HERE, AND THAT IS A PROPERTY OF THIS API
      // RATHER THAN OF EXPRESS. Nest registers these controllers on the root instance --
      // they declare `v1` themselves -- so `baseUrl` is empty. Under a MOUNTED router the
      // same field gives `/channels/:channelId/messages` with no `/v1`, which is the failure
      // `request-context.middleware.ts` already survived once when `req.url` was `/` for
      // every request from chapter 2.2 until the rate-limiter chapter. Asserted, not assumed:
      // if this stops being true the endpoint is dropped rather than recorded wrong.
      const endpoint =
        route?.path !== undefined && baseUrl === "" ? route.path : undefined;

      const stamped = r[REFUSED_AT] as RefusedAt | undefined;
      const refusedAt: RefusedAt =
        stamped ?? (route?.path === undefined ? "unmatched" : "handler");

      const principal = r.principal;
      const environmentId =
        principal !== undefined && "environmentId" in principal
          ? principal.environmentId
          : undefined;

      const facts: RequestFacts = {
        requestId: r.requestId ?? "",
        at: new Date(),
        method: req.method ?? "GET",
        status: res.statusCode,
        latencyMs: Math.round(latencyMs * 1000) / 1000,
        principalKind: principal?.kind ?? "none",
        refusedAt,
        ...(endpoint !== undefined ? { endpoint } : {}),
        ...(environmentId !== undefined ? { environmentId } : {}),
        ...(typeof r[LIMITED_OPERATION] === "string"
          ? { limitedOperation: r[LIMITED_OPERATION] as string }
          : {}),
      };

      // NOT AWAITED. The response has already been sent; this is the whole of constitution
      // III's "never synchronously on the request path" at the one place it could be broken.
      void publishRequest(this.analytics, this.logger, facts);
    });

    next();
  }
}
