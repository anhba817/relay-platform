import {
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
  Scope,
} from "@nestjs/common";

import { MessagesModule } from "../messages/messages.module";
import { AuthModule } from "../auth/auth.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  createMessagePublisher,
  MESSAGE_PUBLISHER,
  type MessagePublisher,
} from "../fanout/publisher";
import { LOGGER, apiLogger } from "../logger";
import type { Logger } from "@relay/service-kit";
import {
  createJetStreamPublisher,
  ensureAnalyticsStream,
} from "../outbox/jetstream.publisher";
import type { Publisher } from "../outbox/publisher";
import { ANALYTICS_PUBLISHER } from "../webhooks/analytics";
import { BackfillController } from "./backfill.controller";
import { InternalController } from "./internal.controller";
import { DispatchController } from "./dispatch.controller";
import { MediaVerificationController } from "./media.controller";
import { MembershipsController } from "./memberships.controller";
import { SessionController } from "./session.controller";
import { UsageController } from "./usage.controller";

// The internal routes reuse MessagesModule's providers wholesale — the
// request-scoped Repository, the guard, the service. One write path, two
// doors (ADR-04/05).
//
// The webhook dispatcher chapter adds the dispatch controller, which needs an UNSCOPED connection
// rather than the request-scoped Repository: one dispatcher serves every
// environment, so its operations take the tenant from the row they touch rather
// than from a principal. `MessagesModule` provides "DB" but does not export it,
// so this module declares its own — the same DEFAULT-scoped factory every other
// module here uses, and a smaller change than widening 2.2's exports for a
// reason 2.2 has nothing to do with.
/** Closes the publisher this module declares. `MessagesModule` has its twin, and the
 * two are separate clients on purpose: sharing one would mean exporting a token that
 * module withholds, and `ANALYTICS_PUBLISHER` already set the precedent for a second
 * client in this process — argued rather than assumed. The cost is one more Redis
 * connection per api instance. */
@Injectable()
export class InternalMessagePublisherLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(MESSAGE_PUBLISHER) private readonly publisher: MessagePublisher,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.publisher.close();
  }
}

@Module({
  imports: [MessagesModule, AuthModule],
  controllers: [
    InternalController,
    BackfillController,
    SessionController,
    DispatchController,
    // REGISTERED HERE, and a controller nobody registers is a route that does not
    // exist — which an analysis pass has found in this repository once already.
    MembershipsController,
    // And this chapter's, for the same reason and in the same place: `app.module.ts`
    // carries only `HealthController` and already imports this module.
    UsageController,
    // The media worker's two routes. Fourth controller in a row registered here with
    // the same note attached, which is how a convention earns the word.
    MediaVerificationController,
  ],
  providers: [
    {
      provide: "DB",
      useFactory: (): Db => createDb(createPool()),
      scope: Scope.DEFAULT,
    },
    // The attempt record's way onto the analytical path. Its own
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
    // FR-MED-07's producer needs a fabric, and this module had no way to reach one.
    //
    // `MessagesModule` declares `MESSAGE_PUBLISHER` and **deliberately does not export
    // it** — its own comment says so — so importing that module gives the controllers
    // here nothing to inject. Same reason `LOGGER` and `ANALYTICS_PUBLISHER` are
    // redeclared above: a provider is visible to the module that declares it and to
    // nothing it imports.
    //
    // **WITHOUT THIS THE FAILURE IS A RUNTIME ONE.** `Nest can't resolve dependencies of
    // the MediaVerificationController` on the first request, after lint, typecheck and
    // every unit test pass — which is exactly what chapter 4.10 recorded when
    // `MediaModule` declared a service it did not provide: *"Only a running app asks
    // that question."* `media-verdict.itest.ts` is the test that asks it.
    {
      provide: MESSAGE_PUBLISHER,
      inject: [LOGGER],
      useFactory: (logger: Logger): MessagePublisher =>
        createMessagePublisher({ logger }),
      scope: Scope.DEFAULT,
    },
    // AND SOMETHING HAS TO CLOSE IT. `MessagesModule` pairs its publisher with a
    // lifecycle for the same reason; a second client with no `OnModuleDestroy` leaks its
    // connection on shutdown, and the api is a process that gets restarted.
    InternalMessagePublisherLifecycle,
  ],
})
export class InternalModule {}
