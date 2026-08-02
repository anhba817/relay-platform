import { createLogger, type Logger } from "@relay/service-kit";

// The logger enters the application as a PROVIDER under an injection token,
// not as a module-level import scattered through the code — that is the DI
// bargain ADR-15 buys: tests swap the sink by overriding one provider.
export const LOGGER = "LOGGER";

export function apiLogger(): Logger {
  return createLogger("api");
}
