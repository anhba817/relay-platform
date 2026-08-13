import { Module, Scope } from "@nestjs/common";

import { MessagesModule } from "../messages/messages.module";
import { AuthModule } from "../auth/auth.module";
import { createDb, createPool, type Db } from "../db/client";
import { BackfillController } from "./backfill.controller";
import { InternalController } from "./internal.controller";
import { DispatchController } from "./dispatch.controller";
import { SessionController } from "./session.controller";

// The internal routes reuse MessagesModule's providers wholesale — the
// request-scoped Repository, the guard, the service. One write path, two
// doors (ADR-04/05).
//
// Chapter 3.5 adds the dispatch controller, which needs an UNSCOPED connection
// rather than the request-scoped Repository: one dispatcher serves every
// environment, so its operations take the tenant from the row they touch rather
// than from a principal. `MessagesModule` provides "DB" but does not export it,
// so this module declares its own — the same DEFAULT-scoped factory every other
// module here uses, and a smaller change than widening 2.2's exports for a
// reason 2.2 has nothing to do with.
@Module({
  imports: [MessagesModule, AuthModule],
  controllers: [
    InternalController,
    BackfillController,
    SessionController,
    DispatchController,
  ],
  providers: [
    {
      provide: "DB",
      useFactory: (): Db => createDb(createPool()),
      scope: Scope.DEFAULT,
    },
  ],
})
export class InternalModule {}
