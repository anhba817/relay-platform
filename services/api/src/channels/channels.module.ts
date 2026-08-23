import { Module, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";

import { AuthModule } from "../auth/auth.module";
import { createDb, createPool, type Db } from "../db/client";
import { Repository } from "../db/repository";
import { ChannelsController } from "./channels.controller";
import { ChannelsService } from "./channels.service";
import type { RequestWithTenant } from "../messages/request-with-tenant";

// The messages module's shape, for the messages module's reasons: the repository
// is the plain 2.1 class, constructed per request with the tenant the middleware
// already resolved from a verified credential (ADR-15).
@Module({
  imports: [AuthModule],
  controllers: [ChannelsController],
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
        new Repository(db, req.principal?.environmentId ?? ""),
    },
    ChannelsService,
  ],
})
export class ChannelsModule {}
