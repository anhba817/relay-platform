import { createLogger } from "@relay/service-kit";

import { createApiClient } from "./api-client.js";
import { storeConfigFromEnv } from "./store.js";
import { sweepOnce } from "./sweep.js";

// THE ONLY SERVICE THAT READS THE BYTES.
//
// A SEPARATE SERVICE, AND CONSTITUTION VII ASKS FOR THE ARGUMENT RATHER THAN THE
// INTUITION. SAD §4.2 lists three criteria for merging a would-be service into an
// existing one and this fails all three: a different datastore (the object store,
// which no other process opens), no transactions shared with the api, and CPU-bound
// work off the request path. ADR-31 carries it.
//
// AND IT IS TYPESCRIPT. VII's language clause is about what Relay is IMPLEMENTED in;
// the scanner this worker will speak to in movement VI's next phase is a program Relay
// ADDRESSES OVER A SOCKET, which is a different thing — the platform already speaks to
// five such programs in four languages. What VII would forbid is writing this file in
// Go.
//
// Frameworkless and ESM, mirroring the dispatcher and the gateway: ADR-15 binds NestJS
// to the API service only.

const INTERVAL_MS = Number(process.env["RELAY_MEDIA_SWEEP_INTERVAL_MS"] ?? 5_000);

async function main(): Promise<void> {
  const logger = createLogger("media-worker");
  const api = createApiClient(
    process.env["RELAY_API_URL"] ?? "http://localhost:4000",
    process.env["RELAY_INTERNAL_CREDENTIAL_WORKER"] ?? "",
  );
  const store = storeConfigFromEnv();

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  logger.log("info", "media worker started", { interval_ms: INTERVAL_MS });

  while (!stopping) {
    try {
      const result = await sweepOnce({ api, store, logger });
      // LOGGED ONLY WHEN SOMETHING HAPPENED. A sweep over an empty backlog every five
      // seconds would otherwise be the loudest thing in the log, and 4.4 measured what
      // a per-request producer costs the analytical path.
      if (result.ready > 0 || result.rejected > 0) {
        logger.log("info", "sweep", {
          seen: result.seen,
          ready: result.ready,
          rejected: result.rejected,
          waiting: result.waiting,
        });
      }
    } catch (error) {
      // THE LOOP OUTLIVES ITS OWN ERRORS. An api that is down, a store that is down, a
      // batch that failed to parse — all of them mean "try again in five seconds", and
      // a process that exited would take the whole verification path down with it
      // until something restarted it.
      logger.log("error", "sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }

  logger.log("info", "media worker stopped");
}

void main();
