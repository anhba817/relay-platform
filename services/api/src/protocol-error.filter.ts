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
    const code = status === 404 ? "not_found" : "internal_error";
    const message =
      exception instanceof HttpException
        ? exception.message
        : "unexpected internal error";
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        code,
        message,
        docs_url: `https://relay.example/docs/errors/${code}`,
      }),
    );
  }
}
