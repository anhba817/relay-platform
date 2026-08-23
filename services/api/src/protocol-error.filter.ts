import type { ServerResponse } from "node:http";

import { docsUrl, ERROR_CODES, type ErrorCode } from "@relay/protocol";

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
    // The credentials chapter widened this twice. A thrower may now NAME its code, because
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
    // TYPED AS `ErrorCode` (FR-025). Four of the five codes this ladder can emit were
    // not in the registry, and `docs_url` is derived from the code, so each shipped a
    // link to a page that could not exist. With the annotation an unregistered code
    // stops compiling here instead of reaching a customer.
    //
    // AND `named` IS CHECKED AGAINST THE REGISTRY RATHER THAN TRUSTED. A thrower can
    // put any string in `code` — `protocolError` makes that hard, not impossible,
    // because `HttpException` is still public — and this filter is the last place that
    // can notice before the string becomes a URL.
    const ladder: ErrorCode =
      status === 400
        ? "invalid_request"
        : status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : status === 404
              ? "not_found"
              : "internal_error";
    // `field` travels the way `code` does — the thrower names it, because only the
    // thrower knows it. Omitted rather than null when there is nothing to name: a key
    // that is always present and usually empty teaches a client to ignore it.
    const field =
      typeof response === "object" &&
      response !== null &&
      typeof (response as { field?: unknown }).field === "string"
        ? (response as { field: string }).field
        : null;
    const code: ErrorCode =
      named !== null && named in ERROR_CODES ? (named as ErrorCode) : ladder;
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
    res.end(
      JSON.stringify({
        code,
        message,
        docs_url: docsUrl(code),
        ...(field !== null ? { field } : {}),
      }),
    );
  }
}
