/** The tokens and the port, in their own file so the controller and the module do not
 *  import each other. */
import type { RequestLogPage } from "./reader";
import type { RequestLogQuery } from "./request-log.schema";

export const REQUEST_LOG_ENDPOINTS = "REQUEST_LOG_ENDPOINTS";

/** The reader as the controller sees it: an abstract class so it is both the type and the
 *  injection token, which is how `Repository` is wired one module over. */
export abstract class RequestLogReaderPort {
  abstract page(environmentId: string, query: RequestLogQuery): Promise<RequestLogPage>;
}

/** THE SET IS READ LATE, AND THAT IS NOT A DETAIL.
 *
 * `deriveTargets` reads the express router off the running application, and providers are
 * constructed while that application is still being built — so a set computed at
 * construction time can be computed before the last controller has registered its routes,
 * and the failure is a filter that silently refuses a real endpoint. Chapter 4.4 hit the
 * same shape from the other side and wrote the rule down: **attach early, read late.** The
 * router is complete by the time a request arrives, which is the only moment this is
 * needed.
 *
 * Memoised on first use rather than recomputed per request: the router does not change
 * after boot, and walking its stack on every page would be work for no answer. */
export interface EndpointSet {
  get(): ReadonlySet<string>;
}
