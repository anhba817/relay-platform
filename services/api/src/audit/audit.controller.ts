import { Controller, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { RequestWithTenant } from "../messages/request-with-tenant";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";
import { protocolError } from "../protocol-error";
import { AUDIT_ACTIONS, AuditReaderPort, type AuditActions } from "./audit.port";
import { buildAuditQuerySchema, type AuditQuery } from "./audit.schema";

/** FR-MOD-03's read surface: the log a tenant can search (chapter 4.18).
 *
 * `Accepts("application")` AND NOT THE DEFAULT, BECAUSE THERE IS NO NEUTRAL OPTION.
 * `CredentialGuard` falls back to EITHER when no decorator is present, so leaving it off
 * is the permissive choice taken silently. A tenant's moderation history is the tenant's:
 * an end-user token here would let any person signed into a customer's product read every
 * ban, removal and deletion that customer's moderators have ever performed.
 *
 * AND THE JOURNEY SAYS IT MORE DIRECTLY THAN THE ANALOGY DOES. `docs/03`'s Journey 3
 * opens: *"Priya never touches Relay directly. She uses an internal support tool that Mai
 * built on Relay's moderation APIs in an afternoon."* The reader of this log is a tool
 * holding an application credential, so application-only is the shape that journey
 * requires rather than a limitation it tolerates.
 *
 * `ZodValidationPipe` IMPORTED FROM `messages/` RATHER THAN MOVED, which is the request
 * log's trade one directory over: that file carries three titled fences in each locale and
 * relocating it would cost six hunks for the sake of an import. */
@Controller("v1/audit-log")
@UseGuards(CredentialGuard)
@Accepts("application")
export class AuditController {
  constructor(
    private readonly reader: AuditReaderPort,
    @Inject(AUDIT_ACTIONS) private readonly actions: AuditActions,
  ) {}

  @Get()
  async page(
    @Req() req: RequestWithTenant,
    @Query() raw: unknown,
  ): Promise<unknown> {
    const environmentId = req.principal?.environmentId;
    // A 403, NOT AN EMPTY PAGE. A `platform` principal carries no `environmentId` BY
    // DESIGN, and `[]` here would say that nobody moderated anything when there is no
    // tenant in the question at all — which is a worse sentence to be wrong about than
    // the request log's, where it would only say nobody called anything.
    if (environmentId === undefined || environmentId === "") {
      throw protocolError(
        "forbidden",
        "this credential resolves to no environment, and an audit log is per environment",
        403,
      );
    }
    const query: AuditQuery = new ZodValidationPipe(
      buildAuditQuerySchema(await this.vocabulary(req, environmentId)),
    ).transform(raw);
    return this.reader.page(environmentId, query);
  }

  /** The classified set, plus what this tenant's rows hold — and the second half costs a
   *  query, so it is only paid when the caller is filtering. A request with no `action`
   *  cannot be refused for naming an unknown one. */
  private async vocabulary(
    req: RequestWithTenant,
    environmentId: string,
  ): Promise<ReadonlySet<string>> {
    const classified = this.actions.classified();
    const raw = (req as { query?: Record<string, unknown> }).query;
    if (raw?.["action"] === undefined) return classified;
    const held = await this.actions.held(environmentId);
    return new Set([...classified, ...held]);
  }
}
