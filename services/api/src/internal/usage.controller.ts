import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";

import { protocolError } from "../protocol-error";

import {
  internalUsageReportRequestSchema,
  type InternalUsageReportRequest,
  type InternalUsageReportResponse,
} from "@relay/protocol";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { Db } from "../db/client";
import {
  ConnectionEnvironmentConflictError,
  creditConnectionMinutes,
} from "../db/repository";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";

// The gateway's only road to a number it can see and cannot write (chapter
// 3.11, constitution IV).
//
// A SEPARATE CONTROLLER FROM THE OTHER `/internal` ROUTES, and the reason is the
// decorator two lines below. `/internal/session`, `/internal/backfill` and
// `/internal/messages` are all `@Accepts("user")` — each is a user's action
// taken through a socket, and the gateway forwards the token it was handed. A
// usage report is nobody's action. Mixing the two credential classes inside one
// controller would make the class-level decorator stop being the answer to "who
// may call this", which is what `dispatch.controller.ts` avoided the same way.
//
// `@Accepts("platform")` AND NOTHING ELSE. An `application` credential is scoped
// to one environment by construction and a report names environments in its
// body: a route that accepted one would either be useless to the gateway or
// would have to ignore that scope, and ignoring a tenant scope is the shape a
// cross-tenant hole takes.
@Controller("internal/usage")
@UseGuards(CredentialGuard)
// FR-044 (chapter 3.12): the CLASS was never enough. Two platform credentials
// exist, `service` said which one answered, and nothing checked it — so the more
// exposed service set the blast radius for both. Here: metering is the gateway's, and the gateway's only.
@Accepts({ platform: ["gateway"] })
export class UsageController {
  constructor(@Inject("DB") private readonly db: Db) {}

  /** `POST /internal/usage/connections` — one request carries every connection
   * the reporting instance holds, open and just-closed alike.
   *
   * IDEMPOTENT IN WHOLE AND IN PART, because each entry states a TOTAL rather
   * than an increment. Re-sending the whole batch credits only what is still
   * owed, so a caller that timed out and retried never has to reason about how
   * much of its last request landed. */
  @Post("connections")
  // 200: nothing is created that the caller can address. The rows are
  // bookkeeping, and the only thing worth telling the caller is how much of what
  // it claimed was new.
  @HttpCode(200)
  async report(
    @Body(new ZodValidationPipe(internalUsageReportRequestSchema))
    body: InternalUsageReportRequest,
  ): Promise<InternalUsageReportResponse> {
    try {
      const credited = await creditConnectionMinutes(
        this.db,
        body.connections.map((c) => ({
          connectionId: c.connection_id,
          environmentId: c.environment_id,
          period: c.period,
          minutes: c.minutes,
        })),
      );
      return { credited };
    } catch (error) {
      // A connection does not move between tenants. Refused rather than
      // reconciled, because reconciling would mean inventing a fact about whose
      // minutes these are (constitution I).
      //
      // Named here rather than left to `ProtocolErrorFilter`: the filter infers
      // a code for four statuses and calls everything else `internal_error`, and
      // 409 is not one of the four.
      if (error instanceof ConnectionEnvironmentConflictError) {
        throw protocolError(
          "connection_environment_conflict",
          "this connection was first reported for a different environment",
          409,
        );
      }
      throw error;
    }
  }
}
