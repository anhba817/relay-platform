import { Controller, Get } from "@nestjs/common";

// The same /healthz contract the frameworkless skeleton answered — the
// framework changes who routes the request, never what the body promises.
@Controller()
export class HealthController {
  @Get("healthz")
  healthz(): Record<string, unknown> {
    return {
      status: "ok",
      service: "api",
      uptime_s: Math.round(process.uptime()),
    };
  }
}
