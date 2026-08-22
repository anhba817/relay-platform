import { Module, Scope } from "@nestjs/common";

import { MessagesModule } from "../messages/messages.module";
import { AuthModule } from "../auth/auth.module";
import { createDb, createPool, type Db } from "../db/client";
import { LOGGER, apiLogger } from "../logger";
import {
  createJetStreamPublisher,
  ensureAnalyticsStream,
} from "../outbox/jetstream.publisher";
import type { Publisher } from "../outbox/publisher";
import { ANALYTICS_PUBLISHER } from "../webhooks/analytics";
import { BackfillController } from "./backfill.controller";
import { InternalController } from "./internal.controller";
import { DispatchController } from "./dispatch.controller";
import { SessionController } from "./session.controller";
import { UsageController } from "./usage.controller";

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
    // Chapter 3.11. Registered HERE and not in `app.module.ts`, which carries
    // only `HealthController` and already imports this module — a controller
    // nobody registers is a route that does not exist, and chapter 3.10's third
    // analysis pass found exactly that.
    UsageController,
  ],
  providers: [
    {
      provide: "DB",
      useFactory: (): Db => createDb(createPool()),
      scope: Scope.DEFAULT,
    },
    // Chapter 3.6: the attempt record's way onto the analytical path. Its own
    // publisher, ensuring its own stream — see ANALYTICS_PUBLISHER's note.
    //
    // The connection is LAZY, as every broker client in this workspace is, and
    // here that property is load-bearing rather than tidy: the api must accept
    // outcome reports with the broker unreachable. If this connected eagerly, a
    // dead broker would take the dispatch seam down with it, which is the exact
    // inversion constitution III forbids.
    {
      provide: ANALYTICS_PUBLISHER,
      useFactory: (): Publisher =>
        createJetStreamPublisher({ ensure: ensureAnalyticsStream }),
      scope: Scope.DEFAULT,
    },
    // `AppModule` provides this too, but a provider is visible to the module that
    // declares it and to nothing it imports — so the controllers here would have
    // nothing to inject. Same factory, so the service name in a log line stays
    // `api` and the log stream does not sprout a second identity for one line.
    {
      provide: LOGGER,
      useFactory: apiLogger,
      scope: Scope.DEFAULT,
    },
  ],
})
export class InternalModule {}
