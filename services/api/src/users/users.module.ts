import { Module, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";

import { AuthModule } from "../auth/auth.module";
import { MembershipModule } from "../membership/membership.module";
import { createDb, createPool, type Db } from "../db/client";
import { Repository } from "../db/repository";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import type { RequestWithTenant } from "../messages/request-with-tenant";
import { actorFrom } from "../audit/actor";
import { LOGGER, apiLogger } from "../logger";
import {
  createJetStreamPublisher,
  ensureAnalyticsStream,
} from "../outbox/jetstream.publisher";
import type { Publisher } from "../outbox/publisher";
import { ANALYTICS_PUBLISHER } from "../webhooks/analytics";

// The channels module's shape, for the channels module's reasons.
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
        new Repository(
          db,
          req.principal?.environmentId ?? "",
          actorFrom(req),
        ),
    },
    // A FOURTH COPY OF THIS FACTORY, and `internal.module.ts` states the rule that
    // forces it: *"a provider is visible to the module that declares it and to nothing
    // it imports"*. 4.21's erasure destroys a user's uploads and owes a negative
    // `deleted` storage delta for each — the operational quota recomputes from the rows
    // and the analytical meter does not, so a skipped delta is a permanent overcount.
    //
    // AND DECLARING A SERVICE WITHOUT ITS PROVIDERS COMPILES, TYPECHECKS AND LINTS,
    // then fails at the first request with `Nest can't resolve dependencies` — 4.10's
    // finding, and the reason this module is edited at all.
    {
      provide: ANALYTICS_PUBLISHER,
      useFactory: (): Publisher =>
        createJetStreamPublisher({ ensure: ensureAnalyticsStream }),
    },
    { provide: LOGGER, useFactory: () => apiLogger() },
    UsersService,
  ],
})
export class UsersModule {}
