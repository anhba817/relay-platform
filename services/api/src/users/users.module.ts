import { Module, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";

import { AuthModule } from "../auth/auth.module";
import { MembershipModule } from "../membership/membership.module";
import { createDb, createPool, type Db } from "../db/client";
import { Repository } from "../db/repository";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import type { RequestWithTenant } from "../messages/request-with-tenant";

// The channels module's shape, for the channels module's reasons (chapter 3.15).
//
// A SEPARATE MODULE AND NOT A ROUTE ON `ChannelsController`. Five SRS clauses need
// routes whose subject is a user — the listing, the profile read, the upsert, the
// deletion, the ban — and hanging them off the channels controller would put user
// lifecycle behind a channel path. `POST /v1/channels/users` is a sentence about
// nothing.
@Module({
  imports: [AuthModule, MembershipModule],
  controllers: [UsersController],
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
    UsersService,
  ],
})
export class UsersModule {}
