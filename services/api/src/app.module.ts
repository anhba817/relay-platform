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
import { ChannelsModule } from "./channels/channels.module";
// Registered here for the reason `ChannelsModule` is: without this
// line the module is compiled, exported, imported by nothing, and none of the user
// routes exist. The file appeared in no task until an enumeration asked which
// chapter fences it.
import { UsersModule } from "./users/users.module";
import { ConsumerModule } from "./consumer/consumer.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { QuotasModule } from "./quotas/quotas.module";
import { OutboxModule } from "./outbox/outbox.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { TenancyModule } from "./tenancy/tenancy.module";
import { LOGGER, apiLogger } from "./logger";
import { ProtocolErrorFilter } from "./protocol-error.filter";
import { LimitsModule } from "./limits/limits.module";
import { RateLimitMiddleware } from "./limits/rate-limit.middleware";
import { RequestContextMiddleware } from "./request-context.middleware";
import { RequestLogMiddleware } from "./request-log/request-log.middleware";
import { RequestLogModule } from "./request-log/request-log.module";
import { ANALYTICS_PUBLISHER } from "./webhooks/analytics";
import { createJetStreamPublisher, ensureAnalyticsStream } from "./outbox/jetstream.publisher";
import type { Publisher } from "./outbox/publisher";

// The application described as a module graph — ADR-15's convention for the
// wide surface Phases 2-4 will grow. Registering the error filter as a
// provider (APP_FILTER) instead of wiring it in main.ts means every entry
// point — including tests — gets the same error envelope for free.
@Module({
  imports: [
    AuthModule,
    MessagesModule,
    ChannelsModule,
    UsersModule,
    InternalModule,
    TenancyModule,
    OutboxModule,
    NotificationsModule,
    QuotasModule,
    ConsumerModule,
    WebhooksModule,
    LimitsModule,
    // Chapter 4.8's read surface. Registered here for the reason `ChannelsModule` and
    // `UsersModule` are: without this line the module compiles, is imported by nothing,
    // and the route does not exist — which `pnpm build` would not notice and the
    // cross-tenant gauntlet would, because it derives its targets from the router.
    RequestLogModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: LOGGER, useFactory: apiLogger },
    { provide: APP_FILTER, useClass: ProtocolErrorFilter },
    RequestContextMiddleware,
    RateLimitMiddleware,
    RequestLogMiddleware,
    // PROVIDED HERE TOO, AND THAT IS NOT A DUPLICATE BY ACCIDENT. `ANALYTICS_PUBLISHER` is
    // declared in `webhooks/analytics.ts` and provided in `InternalModule`, which has NO
    // `exports:` array -- and `internal.module.ts` states the rule twelve lines below that
    // provider: "a provider is visible to the module that declares it and to nothing it
    // imports". Middleware configured in `AppModule.configure()` resolves from AppModule's
    // injector, so without this line Nest cannot construct `RequestLogMiddleware` and the
    // process fails at boot.
    //
    // Same factory, provided twice, follows `LOGGER`'s precedent in that same file. The cost
    // is a second publisher instance: a second NATS connection and a second idempotent
    // `ensureAnalyticsStream` call at boot. The connection is lazy, so an unreachable broker
    // still leaves the api serving requests.
    {
      provide: ANALYTICS_PUBLISHER,
      useFactory: (): Publisher => createJetStreamPublisher({ ensure: ensureAnalyticsStream }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Order is the chain: the request gets its id first, then its principal,
    // then its allowance. The limiter is LAST and that is forced:
    // it counts per environment and the environment comes from the credential,
    // so nothing earlier in the chain knows which tenant is asking.
    // The credentials chapter put authentication HERE rather than in a guard because Nest
    // constructs request-scoped providers before the enhancer chain runs — the
    // finding 2.6 paid for, measured again on this path in T004.
    // REQUEST LOG IS SECOND, NOT LAST, AND THE POSITION IS LOAD-BEARING.
    // `RateLimitMiddleware` refuses a 429 with `res.end(); return;` and never calls
    // `next()`, so a producer registered after it never runs -- and a rate-limited request
    // is exactly the one an operator opens a request log to find. Second, it attaches its
    // `finish` listener before anything can short-circuit, and reads `req.principal` when
    // the listener fires rather than when it is attached. Attach early, read late.
    consumer
      .apply(
        RequestContextMiddleware,
        RequestLogMiddleware,
        AuthenticateMiddleware,
        RateLimitMiddleware,
      )
      .forRoutes("{*path}");
  }
}
