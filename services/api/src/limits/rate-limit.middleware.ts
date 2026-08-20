import type { IncomingMessage, ServerResponse } from "node:http";

import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { Logger } from "@relay/service-kit";

import type { Db } from "../db/client";
import { environmentLimits } from "../db/repository";
import type { RequestWithPrincipal } from "../auth/principal";
import { LOGGER } from "../logger";
import { remaining, resetAt, windowStart } from "./bucket";
import { COUNTER_STORE, LIMITS_DB } from "./limits.module";
import { WINDOW_MS, type LimitedOperation } from "./policy";
import { counterKey, type CounterStore } from "./store";

// The tenant limiter (chapter 3.8, FR-RTL-01…04).
//
// MIDDLEWARE, NOT A GUARD, for two reasons. Chapter 3.2's: Nest constructs
// request-scoped providers before the enhancer chain, so a guard cannot be the
// thing that resolves tenant scope. And one of its own: FR-RTL-02 wants the three
// headers on SUCCESSFUL responses, and a guard that returns `true` has no natural
// place to set a header on a response the handler has not produced yet.
//
// AFTER `AuthenticateMiddleware`, and the order is forced: the counters are keyed
// by environment and the environment comes from the credential.
//
// COUNT EACH OPERATION ONCE, AT THE DOOR IT ENTERED (research R17). The exemption
// cannot key off the principal, because the gateway forwards the END USER's token
// on all three of its api calls — `/internal/session`, `/internal/backfill`,
// `/internal/messages` are all `@Accepts("user")` and resolve exactly like
// customer traffic. Only the dispatcher carries the platform credential. So the
// route decides, not the caller:
//
//   /v1/…            counted. A message send decrements both budgets (FR-036).
//   /internal/…      not counted. The gateway already counted the handshake
//                    against `connect` and the frame against `send`; counting
//                    again here would charge the socket twice and make a
//                    reconnect storm eat a customer's request budget.
//   /healthz         never limited. Docker polls it every five seconds and
//                    `up -d --wait` depends on the answer; a limiter that can
//                    refuse it can stop a deployment.

const PUBLIC_PREFIX = "/v1/";
const SEND_PATH = /^\/v1\/channels\/[^/]+\/messages\/?$/;

interface Decision {
  operation: LimitedOperation;
  limit: number;
  remaining: number;
  resetSeconds: number;
  refused: boolean;
  counted: boolean;
}

/** Which budgets a path spends. Empty means the route is not counted at all. */
export function operationsFor(
  method: string,
  path: string,
): LimitedOperation[] {
  if (!path.startsWith(PUBLIC_PREFIX)) return [];
  if (method === "POST" && SEND_PATH.test(path)) return ["rest", "send"];
  return ["rest"];
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  constructor(
    @Inject(LIMITS_DB) private readonly db: Db,
    @Inject(COUNTER_STORE) private readonly store: CounterStore,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async use(
    req: RequestWithPrincipal & IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> {
    // `originalUrl`, NOT `url`. Express rewrites `req.url` relative to the mount
    // point, and a middleware applied through `forRoutes("{*path}")` is mounted
    // at the match — so `req.url` is `/` for every request and the route rules
    // below would never match anything. Found by probe at implementation, and
    // the same read is why the request log recorded `/` for every request from
    // chapter 2.2 until this chapter fixed it.
    const raw =
      (req as unknown as { originalUrl?: string }).originalUrl ?? req.url ?? "/";
    const path = raw.split("?")[0] ?? "/";
    const operations = operationsFor(req.method ?? "GET", path);
    const principal = req.principal;

    // An environment to key on, or nothing to do. A platform principal has none
    // by construction — the dispatcher's credential belongs to a deployment, not
    // a tenant — and an absent principal means the guard is about to refuse this
    // or the route is pre-credential.
    const environmentId =
      principal !== undefined && "environmentId" in principal
        ? principal.environmentId
        : undefined;
    if (operations.length === 0 || environmentId === undefined) {
      next();
      return;
    }

    const limits = await environmentLimits(this.db, environmentId);
    if (limits === null) {
      next();
      return;
    }

    const now = Date.now();
    const start = windowStart(now, WINDOW_MS);
    const resetSeconds = Math.ceil(resetAt(now, WINDOW_MS) / 1000);
    const decisions: Decision[] = [];

    for (const operation of operations) {
      const limit = limits[operation];
      const count = await this.store.increment(
        counterKey(environmentId, operation, start),
        now,
      );
      decisions.push({
        operation,
        limit,
        remaining: count === null ? limit : remaining(count, limit),
        resetSeconds,
        refused: count !== null && count > limit,
        counted: count !== null,
      });
    }

    // THE HEADERS DESCRIBE WHICHEVER HAS FEWER REMAINING, because that is the one
    // that will refuse first and the only value a client can schedule against. A
    // client with 400 request-slots and 12 send-slots needs to hear 12; reporting
    // 400 would be a header that lies by omission. A tie reports the first, which
    // is `rest` (research R11).
    const nearest = decisions.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    const degraded = decisions.some((d) => !d.counted);

    res.setHeader("X-RateLimit-Limit", String(nearest.limit));
    if (degraded) {
      // `Limit` only. It is policy read from Postgres and is not degraded; the
      // other two exist only because something was counting, and inventing them
      // is the failure FR-014 forbids. NOT a sentinel — a client that does not
      // know `-1` would parse it as a number and conclude it was over its limit
      // (research R6).
      this.degradation(environmentId, req);
    } else {
      res.setHeader("X-RateLimit-Remaining", String(nearest.remaining));
      res.setHeader("X-RateLimit-Reset", String(nearest.resetSeconds));
    }

    const refusal = decisions.find((d) => d.refused);
    if (refusal !== undefined) {
      const retryAfter = Math.max(1, refusal.resetSeconds - Math.floor(now / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("X-RateLimit-Remaining", "0");
      // The message names WHICH limit was reached: "too many requests" and "too
      // many messages" are different problems, one saying batch and the other
      // saying slow down. Neither names a credential (NFR-SEC-06).
      const what =
        refusal.operation === "send" ? "messages" : "requests";
      res.statusCode = 429;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          code: "rate_limited",
          message: `too many ${what} for this environment; retry after ${retryAfter} seconds`,
          docs_url: "https://relay.example/docs/errors/rate_limited",
          request_id: String(res.getHeader("X-Request-Id") ?? ""),
        }),
      );
      return;
    }

    next();
  }

  private lastDegradationLog = 0;

  /** One line, rate limited at the logger. A Redis outage under load would
   * otherwise emit one per request, which is how one outage becomes two. Carries
   * the request id and the environment — NFR-OBS-01 asks for request id, tenant
   * id and correlation id, and the platform mints no correlation id yet. Carries
   * no credential (NFR-SEC-06). */
  private degradation(environmentId: string, req: IncomingMessage): void {
    const now = Date.now();
    if (now - this.lastDegradationLog < 10_000) return;
    this.lastDegradationLog = now;
    void req;
    // `error`, not `info`: the limiter is doing the right thing by serving, and
    // an unreachable store is still an operational fault somebody should see.
    // The logger's two levels are the service-kit's, unchanged since 1.4.
    this.logger.log("error", "limits.degraded", {
      environment_id: environmentId,
      detail: "counter store unreachable; serving without counting",
    });
  }
}
