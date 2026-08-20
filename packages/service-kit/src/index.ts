import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

// The operational plumbing every Relay service shares — ONE home, because
// the second copy is where drift starts (chapter 1.4's TRAP; 1.1's lesson
// applied to behavior instead of configuration).
//
// Logs are structured JSON, one object per line (NFR-OBS-01): request_id is
// real from day one; tenant_id and trace/correlation ids are recorded
// deferrals — they join when Part 2's data paths and NFR-OBS-02's tracing
// make them mean something.

export type LogSink = (line: string) => void;

const stdoutSink: LogSink = (line) => {
  process.stdout.write(line + "\n");
};

export interface Logger {
  log(
    level: "info" | "error",
    msg: string,
    fields?: Record<string, unknown>,
  ): void;
}

/** One JSON object per line; the sink is injectable so tests can assert log
 * structure instead of scraping stdout — observability you can't test rots. */
export function createLogger(
  service: string,
  sink: LogSink = stdoutSink,
): Logger {
  return {
    log(level, msg, fields = {}) {
      sink(
        JSON.stringify({
          time: new Date().toISOString(),
          level,
          service,
          msg,
          ...fields,
        }),
      );
    },
  };
}

/** EIR-API-05 fixes uniqueness; the UUID format is chapter 1.4's decision. */
export function newRequestId(): string {
  return randomUUID();
}

export interface ServeOptions {
  service: string;
  /** Extra fields merged into the /healthz payload. */
  health: () => Record<string, unknown>;
  logger?: Logger;
}

/** Build (but do not start) a service's HTTP server: every response carries
 * X-Request-Id (EIR-API-05), every request logs exactly one structured line
 * carrying the same id (NFR-OBS-06's grep-ability starts here), GET /healthz
 * answers with the service's health payload, and unknown routes get the
 * EIR-API-04 error shape. The docs_url host is a placeholder until the docs
 * site exists — constitution V's reachable-page promise lands with it. */
export function serve(options: ServeOptions): Server {
  const { service, health } = options;
  const logger = options.logger ?? createLogger(service);
  return createServer((req, res) => {
    const requestId = newRequestId();
    const path = req.url ?? "/";
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("content-type", "application/json");

    let status: number;
    let body: unknown;
    if (req.method === "GET" && path === "/healthz") {
      status = 200;
      body = { status: "ok", service, ...health() };
    } else {
      status = 404;
      body = {
        code: "not_found",
        message: `no route for ${req.method ?? "?"} ${path}`,
        docs_url: "https://relay.example/docs/errors/not_found",
        // Chapter 3.8: the fourth field constitution V has asked for since 1.3.
        // Everywhere, not only on the rate-limit error — four fields on one
        // status and three on the others is worse than either consistent answer.
        request_id: requestId,
      };
    }
    res.statusCode = status;
    res.end(JSON.stringify(body));
    logger.log("info", "request", {
      request_id: requestId,
      method: req.method,
      path,
      status,
    });
  });
}
