import { Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";

import { createLogger } from "@relay/service-kit";

import {
  createMembershipPublisher,
  MEMBERSHIP_PUBLISHER,
  type MembershipPublisher,
} from "./publisher";

// ONE MODULE, TWO IMPORTERS (chapter 3.20).
//
// `ChannelsModule` and `UsersModule` both publish membership changes, and registering
// the factory in each would open two Redis connections for one job. A module they
// both import is one connection, one lifecycle, one place to look.
//
// EXPORTED, WHERE `MESSAGE_PUBLISHER` IS NOT — and the difference is worth stating
// because the precedent looks like it says otherwise. `messages.module.ts` withholds
// its publisher deliberately: `internal.module.ts` imports that module and "reuse[s]
// MessagesModule's providers wholesale", so an exported publisher would be injectable
// from the one route that must never publish. Checked rather than assumed for this
// one: `ChannelsModule` and `UsersModule` are imported only by `app.module.ts`, and
// this module is imported only by them. There is no wholesale reuse to leak through.
//
// Anyone adding a third importer should re-read that paragraph first.

/** `limits/limits.module.ts:10` states the convention: "resource in this api closes
 * through `OnModuleDestroy`". Six modules implement it; this is the seventh. A
 * `close()` nothing calls is a leaked handle in a service that boots once per
 * integration suite, and the symptom is a suite that hangs rather than one that
 * fails. */
@Injectable()
export class MembershipPublisherLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(MEMBERSHIP_PUBLISHER)
    private readonly publisher: MembershipPublisher,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.publisher.close();
  }
}

@Module({
  providers: [
    {
      provide: MEMBERSHIP_PUBLISHER,
      useFactory: (): MembershipPublisher =>
        createMembershipPublisher({ logger: createLogger("api") }),
    },
    MembershipPublisherLifecycle,
  ],
  exports: [MEMBERSHIP_PUBLISHER],
})
export class MembershipModule {}
