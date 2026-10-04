import { Body, Controller, Param, Patch, Req, UseGuards } from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import { createDb, createPool } from "../db/client";
import { setRetentionPolicy } from "../db/repository";
import type { RequestWithTenant } from "../messages/request-with-tenant";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";
import { protocolError } from "../protocol-error";
import { patchEnvironmentSchema, type PatchEnvironment } from "./environments.schema";

const db = createDb(createPool());

/** FR-MOD-06's write surface: the only thing that sets a retention policy.
 *
 * `Accepts("application")` AND NOT THE DEFAULT. `CredentialGuard` falls back to EITHER
 * when no decorator is present, so leaving it off is the permissive choice taken
 * silently — and chapter 4.18 measured what that is worth: deleting this decorator from
 * the audit route answered an end-user token **200 with the tenant's whole moderation
 * history**, while the controller's own 403 defended a case that could not arise.
 *
 * HERE THE CONSEQUENCE IS WORSE THAN DISCLOSURE. A retention policy destroys content:
 * an end-user token that could set thirty days would destroy the tenant's history.
 * The decorator is the decision, and `retention.itest.ts` deletes it and re-runs rather
 * than reading it.
 *
 * THE SWEEP IS NOT A ROUTE AND THAT IS DELIBERATE (ADR-28's precedent, research R3).
 * Nothing in this platform schedules anything, so a route that ran the sweep would
 * publish a promise with no mechanism behind it. The policy is API-first; the sweep is
 * a command an operator invokes. */
@Controller("v1/environments")
@UseGuards(CredentialGuard)
@Accepts("application")
export class EnvironmentsController {
  @Patch(":environmentId")
  async patch(
    @Req() req: RequestWithTenant,
    @Param("environmentId") environmentId: string,
    @Body(new ZodValidationPipe(patchEnvironmentSchema)) body: PatchEnvironment,
  ): Promise<unknown> {
    // ANOTHER TENANT'S ENVIRONMENT IS INDISTINGUISHABLE FROM ONE THAT DOES NOT EXIST.
    // Constitution I: a refusal that names the cause reports whether somebody else's
    // environment is there, which chapter 4.11 made the rule for media objects.
    //
    // `?.` RATHER THAN A BRANCH FOR THE ABSENT PRINCIPAL. A platform principal carries
    // no `environmentId` by design (chapter 4.4), and `@Accepts("application")` refuses
    // it before this line runs — so an explicit 403 here would defend a case that
    // cannot arise, which is exactly what chapter 4.18 found and deleted. The optional
    // chain makes a missing principal fail the comparison and answer 404 like any other
    // environment the caller may not have.
    if (environmentId !== req.principal?.environmentId) {
      throw protocolError("not_found", "environment not found", 404);
    }

    // AN ABSENT KEY CHANGES NOTHING AND `null` CLEARS THE POLICY. The schema keeps the
    // two apart and so does this: testing the VALUE would make an omitted field mean
    // *indefinite*, which is a destructive reading of a request that asked for nothing.
    if (!("retention_days" in body)) {
      throw protocolError(
        "invalid_request",
        "retention_days is required",
        400,
        "retention_days",
      );
    }

    const row = await setRetentionPolicy(db, environmentId, body.retention_days ?? null);
    if (row === undefined) {
      throw protocolError("not_found", "environment not found", 404);
    }
    return { id: row.id, name: row.name, retention_days: row.retentionDays };
  }
}
