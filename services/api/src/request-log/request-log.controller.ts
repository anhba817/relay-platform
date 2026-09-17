import { Controller, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { RequestWithTenant } from "../messages/request-with-tenant";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";
import { protocolError } from "../protocol-error";
import {
  REQUEST_LOG_ENDPOINTS,
  RequestLogReaderPort,
  type EndpointSet,
} from "./request-log.port";
import { buildRequestLogQuerySchema, type RequestLogQuery } from "./request-log.schema";

/** FR-ANL-07's surface: the log a customer can search (chapter 4.8).
 *
 * `Accepts("application")` AND NOT THE DEFAULT, BECAUSE THERE IS NO NEUTRAL OPTION.
 * `CredentialGuard` falls back to `EITHER` — application and user both — when no decorator
 * is present (`credential.guard.ts:92`), so leaving it off is the permissive choice taken
 * silently. A request log is closer to configuration than to content, which is the
 * reasoning `WebhooksController` already carries one directory over: an end-user token here
 * would let any logged-in person in a customer's product read that customer's whole API
 * history — every endpoint they called, when, and what it answered. The tenant's software
 * may read its own log; a person signed into the tenant's product may not.
 *
 * `ZodValidationPipe` IMPORTED FROM `messages/` RATHER THAN MOVED. That file carries three
 * titled fences in each locale — counted, not assumed — and relocating it to a shared
 * directory would cost six hunks for the sake of an import statement. Same trade the schema
 * makes with `messages.schema.ts`. */
@Controller("v1/request-log")
@UseGuards(CredentialGuard)
@Accepts("application")
export class RequestLogController {
  constructor(
    private readonly reader: RequestLogReaderPort,
    @Inject(REQUEST_LOG_ENDPOINTS) private readonly endpoints: EndpointSet,
  ) {}

  @Get()
  async page(
    @Req() req: RequestWithTenant,
    @Query() raw: unknown,
  ): Promise<unknown> {
    const environmentId = req.principal?.environmentId;
    // A 403, NOT AN EMPTY PAGE (FR-011). A `platform` principal carries no
    // `environmentId` BY DESIGN — its own comment says the absence is what stops it being
    // usable where a tenant is expected — and answering it with `[]` would say that a
    // tenant made no requests when there is no tenant in the question at all.
    if (environmentId === undefined || environmentId === "") {
      throw protocolError(
        "forbidden",
        "this credential resolves to no environment, and a request log is per environment",
        403,
      );
    }
    // VALIDATED AGAINST THE ROUTER AS IT IS NOW, which is why the schema is built per
    // request from an injected set rather than at import time.
    const query: RequestLogQuery = new ZodValidationPipe(
      buildRequestLogQuerySchema(this.endpoints.get()),
    ).transform(raw);
    return this.reader.page(environmentId, query);
  }
}
