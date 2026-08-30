import { Module } from "@nestjs/common";

import { MessagesModule } from "../messages/messages.module";
import { AuthModule } from "../auth/auth.module";
import { BackfillController } from "./backfill.controller";
import { InternalController } from "./internal.controller";
import { MembershipsController } from "./memberships.controller";
import { SessionController } from "./session.controller";

// The internal routes reuse MessagesModule's providers wholesale — the
// request-scoped Repository, the guard, the service. One write path, two
// doors (ADR-04/05).
@Module({
  imports: [MessagesModule, AuthModule],
  controllers: [
    InternalController,
    BackfillController,
    SessionController,
    // REGISTERED HERE, and a controller nobody registers is a route that does not
    // exist — which an analysis pass has found in this repository once already.
    MembershipsController,
  ],
})
export class InternalModule {}
