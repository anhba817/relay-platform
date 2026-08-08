import { Module, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";

import { AuthModule } from "../auth/auth.module";
import { createDb, createPool, type Db } from "../db/client";
import type { RequestWithTenant } from "./request-with-tenant";
import { Repository } from "../db/repository";
import { MessagesController } from "./messages.controller";
import { MessagesService } from "./messages.service";

// The repository stays the plain 2.1 class — the framework's job is only
// to construct it per request with the authenticated tenant (ADR-15's
// scope note: guards authenticate, the data layer isolates).
@Module({
  imports: [AuthModule],
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
        // The FACTORY reads the PRINCIPAL, not the guard's leftovers: Nest
        // resolves request-scoped providers BEFORE the enhancer chain
        // runs, so anything a guard stashes on the request is invisible
        // here. Middleware runs earlier still, which is why chapter 3.2
        // authenticates there (research R5, measured in T004).
        //
        // Chapter 3.2 changed WHERE the environment comes from and nothing
        // else about this line. It used to be an environment header — a
        // header any caller could type. It is now the environment resolved
        // from a verified credential, so a request cannot name a tenant it
        // has not proved it may act for. The empty-string fallback is the
        // same as 2.2's: no principal means no scope, and the guard below
        // turns that into a 401 before any handler runs.
        new Repository(db, req.principal?.environmentId ?? ""),
    },
    MessagesService,
  ],
  exports: [Repository, MessagesService],
})
export class MessagesModule {}
