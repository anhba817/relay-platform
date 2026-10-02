import { Module, Scope } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { createDb, createPool, type Db } from "../db/client";
import { auditActionsHeld } from "../db/audit-reads";
import { createAuditReader } from "./audit.reader";
import { AuditController } from "./audit.controller";
import { AUDIT_ACTIONS, AuditReaderPort, type AuditActions } from "./audit.port";
import { MODERATION_ROUTES } from "./moderation-routes";

/** THE FILTER'S VOCABULARY IS TWO SETS AND ONLY ONE OF THEM IS DERIVED FROM A LIST.
 *
 * The classified half comes from `MODERATION_ROUTES`, which `audit.itest.ts` checks in
 * both directions against the routes a booted application reports — a derived target with
 * no entry fails, and an entry with no derived target fails too. It is the same mechanism
 * `isolation/targets.ts` uses and the reason this feature put the classification in a
 * sibling rather than a field on that file is measured in the sibling's own header.
 *
 * The held half is a query, and it is this chapter's addition to the request log's shape.
 * That module considered deriving its vocabulary from the data and declined because it
 * *"costs a query per page"*; here it costs a query only on a request that filters, which
 * is the one request where it could matter. */
export function createAuditActions(db: Db): AuditActions {
  const classified = new Set(
    Object.entries(MODERATION_ROUTES)
      .filter(([, kind]) => kind !== "not-moderation")
      .map(([route]) => route),
  );
  return {
    classified: () => classified,
    held: async (environmentId) => new Set(await auditActionsHeld(db, environmentId)),
  };
}

@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [
    {
      provide: "AUDIT_DB",
      useFactory: (): Db => createDb(createPool()),
      scope: Scope.DEFAULT,
    },
    {
      provide: AuditReaderPort,
      inject: ["AUDIT_DB"],
      useFactory: (db: Db) => createAuditReader(db),
    },
    {
      provide: AUDIT_ACTIONS,
      inject: ["AUDIT_DB"],
      useFactory: createAuditActions,
    },
  ],
})
export class AuditModule {}
