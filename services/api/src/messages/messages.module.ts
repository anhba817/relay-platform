import { Module, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";

import { createDb, createPool, type Db } from "../db/client";
import type { RequestWithTenant } from "./request-with-tenant";
import { Repository } from "../db/repository";
import { EnvironmentContextGuard } from "./environment-context.guard";
import { MessagesController } from "./messages.controller";
import { MessagesService } from "./messages.service";

// The repository stays the plain 2.1 class — the framework's job is only
// to construct it per request with the authenticated tenant (ADR-15's
// scope note: guards authenticate, the data layer isolates).
@Module({
  controllers: [MessagesController],
  providers: [
    {
      provide: "DB",
      useFactory: (): Db => createDb(createPool()),
      scope: Scope.DEFAULT,
    },
    {
      provide: Repository,
      scope: Scope.REQUEST,
      inject: ["DB", REQUEST],
      useFactory: (db: Db, req: RequestWithTenant) =>
        // The FACTORY reads the header, not the guard's leftovers: Nest
        // resolves request-scoped providers BEFORE the enhancer chain
        // runs, so anything a guard stashes on the request is invisible
        // here. The guard still rejects tenant-less requests (401); the
        // factory is what scopes the layer.
        new Repository(db, req.headers["x-relay-environment"] ?? ""),
    },
    MessagesService,
    EnvironmentContextGuard,
  ],
  exports: [Repository, MessagesService, EnvironmentContextGuard],
})
export class MessagesModule {}
