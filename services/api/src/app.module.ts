import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { AuthModule } from "./auth/auth.module";
import { AuthenticateMiddleware } from "./auth/authenticate.middleware";
import { HealthController } from "./health.controller";
import { InternalModule } from "./internal/internal.module";
import { MessagesModule } from "./messages/messages.module";
import { ConsumerModule } from "./consumer/consumer.module";
import { OutboxModule } from "./outbox/outbox.module";
import { TenancyModule } from "./tenancy/tenancy.module";
import { LOGGER, apiLogger } from "./logger";
import { ProtocolErrorFilter } from "./protocol-error.filter";
import { RequestContextMiddleware } from "./request-context.middleware";

// The application described as a module graph — ADR-15's convention for the
// wide surface Phases 2-4 will grow. Registering the error filter as a
// provider (APP_FILTER) instead of wiring it in main.ts means every entry
// point — including tests — gets the same error envelope for free.
@Module({
  imports: [
    AuthModule,
    MessagesModule,
    InternalModule,
    TenancyModule,
    OutboxModule,
    ConsumerModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: LOGGER, useFactory: apiLogger },
    { provide: APP_FILTER, useClass: ProtocolErrorFilter },
    RequestContextMiddleware,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Order is the chain: the request gets its id first, then its principal.
    // Chapter 3.2 put authentication HERE rather than in a guard because Nest
    // constructs request-scoped providers before the enhancer chain runs — the
    // finding 2.6 paid for, measured again on this path in T004.
    consumer
      .apply(RequestContextMiddleware, AuthenticateMiddleware)
      .forRoutes("{*path}");
  }
}
