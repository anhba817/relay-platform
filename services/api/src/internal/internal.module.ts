import { Module } from "@nestjs/common";

import { MessagesModule } from "../messages/messages.module";
import { AuthModule } from "../auth/auth.module";
import { BackfillController } from "./backfill.controller";
import { InternalController } from "./internal.controller";
import { SessionController } from "./session.controller";

// The internal routes reuse MessagesModule's providers wholesale — the
// request-scoped Repository, the guard, the service. One write path, two
// doors (ADR-04/05).
@Module({
  imports: [MessagesModule, AuthModule],
  controllers: [InternalController, BackfillController, SessionController],
})
export class InternalModule {}
