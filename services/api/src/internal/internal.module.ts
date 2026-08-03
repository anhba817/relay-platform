import { Module } from "@nestjs/common";

import { MessagesModule } from "../messages/messages.module";
import { InternalController } from "./internal.controller";

// The internal routes reuse MessagesModule's providers wholesale — the
// request-scoped Repository, the guard, the service. One write path, two
// doors (ADR-04/05).
@Module({
  imports: [MessagesModule],
  controllers: [InternalController],
})
export class InternalModule {}
