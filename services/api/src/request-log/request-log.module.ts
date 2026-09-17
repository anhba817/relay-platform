import { Module } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";

import { AuthModule } from "../auth/auth.module";
import { deriveTargets } from "../isolation/targets";
import { createRequestLogReader } from "./reader";
import { RequestLogController } from "./request-log.controller";
import {
  REQUEST_LOG_ENDPOINTS,
  RequestLogReaderPort,
  type EndpointSet,
} from "./request-log.port";

/** THE ACCEPTED ENDPOINT SET COMES FROM THE RUNNING ROUTER, NOT FROM A LIST (FR-035, R9).
 *
 * `AnalyticalStore.query` takes a SQL string and has no parameter binding, so `endpoint` is
 * the sharpest caller-supplied value on this surface. The defence is a closed set, and the
 * set is DERIVED: `deriveTargets(app.getHttpAdapter().getInstance())` is the cross-tenant
 * suite's own mechanism (`isolation/targets.ts`), and its argument applies here word for
 * word — only the router knows what exists. A hand-maintained list of filterable endpoints
 * would be another of the tables this project has had to delete rather than correct.
 *
 * WHAT THE DERIVED SET COSTS IS IN THE CONTRACT. It describes the router as it is now; the
 * log holds thirty days. A route retired in a later release leaves rows that are still
 * returned and can no longer be named, until they expire. Deriving from the data instead —
 * `SELECT DISTINCT endpoint` in the window — would cover them and costs a query per page.
 *
 * `unmatched` IS NOT IN THIS SET AND IS ACCEPTED ANYWAY, because the router contains no
 * route for the request that matched none, and that is the query a 404 investigation opens
 * the log for. `request-log.schema.ts` holds that member. */
export function createEndpointSet(adapters: HttpAdapterHost): EndpointSet {
  let cached: ReadonlySet<string> | null = null;
  return {
    get(): ReadonlySet<string> {
      if (cached === null) {
        const { targets } = deriveTargets(adapters.httpAdapter?.getInstance());
        cached = new Set(targets.map((t) => t.path));
      }
      return cached;
    },
  };
}

@Module({
  imports: [AuthModule],
  controllers: [RequestLogController],
  providers: [
    { provide: RequestLogReaderPort, useFactory: () => createRequestLogReader() },
    {
      provide: REQUEST_LOG_ENDPOINTS,
      inject: [HttpAdapterHost],
      useFactory: createEndpointSet,
    },
  ],
})
export class RequestLogModule {}
