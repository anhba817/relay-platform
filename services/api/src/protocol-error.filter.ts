import type { ServerResponse } from "node:http";

import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";

// EIR-API-04: one error shape, one home. Whatever throws — the router's own
// 404, a future guard, an unhandled bug — the wire sees the same envelope
// the @relay/protocol error payload defines, so the REST surface and the
// WebSocket surface cannot drift apart. The docs_url host is a placeholder
// until the docs site exists (constitution V's reachable-page promise).
@Catch()
export class ProtocolErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ServerResponse>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    // REST error codes by status (chapter 2.2 widened this: a 400 that
    // calls itself "internal_error" is a lie the client cannot act on).
    // The registry stays here until an API chapter owns a REST one.
    //
    // Chapter 3.2 widened this twice. A thrower may now NAME its code, because
    // `wrong_credential_type` is a distinction the status alone cannot carry: a
    // 403 that calls itself "forbidden" tells an integrator they lack a
    // permission, when what they actually did was present the wrong kind of
    // credential. And 403 finally has a fallback — it used to land in
    // "internal_error", which was a lie in the same family as the 400 that 2.2
    // fixed.
    const response =
      exception instanceof HttpException ? exception.getResponse() : null;
    const named =
      typeof response === "object" &&
      response !== null &&
      typeof (response as { code?: unknown }).code === "string"
        ? (response as { code: string }).code
        : null;
    const code =
      named ??
      (status === 400
        ? "invalid_request"
        : status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : status === 404
              ? "not_found"
              : "internal_error");
    const message =
      exception instanceof HttpException
        ? exception.message
        : "unexpected internal error";
    // `field` travels the way `code` does — the thrower names it, because only the
    // thrower knows it. Omitted rather than null when there is nothing to name: a
    // key that is always present and usually empty teaches a client to ignore it.
    const field =
      typeof response === "object" &&
      response !== null &&
      typeof (response as { field?: unknown }).field === "string"
        ? (response as { field: string }).field
        : null;
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    // FOUR FIELDS AS OF CHAPTER 3.8, and constitution V has asked for four since
    // chapter 1.3. `request_id` was promised "in Part 2, when a gateway exists to
    // mint one"; the gateway arrived and the field did not. It is read back off
    // the response rather than threaded through, because `RequestContextMiddleware`
    // has already set `X-Request-Id` by the time anything can throw — one id, in
    // the header and the body, from one place.
    //
    // TOP-LEVEL, NOT NESTED. EIR-API-04's worked example wrapped these in an
    // `error` key until this chapter checked what the platform actually sends;
    // it never sent that shape. Wrapping every error response would be a breaking
    // change and CON-05 makes breaking changes a URL-versioning event, so the
    // document was brought to the code — SRS 1.3 (research R27).
    res.end(
      JSON.stringify({
        code,
        message,
        docs_url: `https://relay.example/docs/errors/${code}`,
        request_id: String(res.getHeader("X-Request-Id") ?? ""),
        ...(field !== null ? { field } : {}),
      }),
    );
  }
}
