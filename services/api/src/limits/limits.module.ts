import { Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";

import { createDb, createPool, type Db } from "../db/client";
import { apiLogger, LOGGER } from "../logger";
import { createCounterStore, type CounterStore } from "./store";

// The counter store's home (chapter 3.8).
//
// It is a module for one reason: the client has to be closed. Every long-lived
// resource in this api closes through `OnModuleDestroy` — the outbox relay, the
// delivery relay, the event consumer — `main.ts` enables shutdown hooks, and
// every api integration suite ends `await app.close()`.
//
// An ioredis client holds the event loop open. Without the hook the suites would
// HANG AFTER THEIR ASSERTIONS PASS, which is the worst shape available: green
// tests and a lane that never returns, in a project that has spent three chapters
// clearing one (research R20).

export const COUNTER_STORE = "COUNTER_STORE";
/** The limiter's own pool. Its own rather than the auth middleware's, because a
 * middleware that had to be handed another middleware's connection would couple
 * two things that only share a request. */
export const LIMITS_DB = "LIMITS_DB";

@Injectable()
export class CounterStoreLifecycle implements OnModuleDestroy {
  constructor(@Inject(COUNTER_STORE) private readonly store: CounterStore) {}

  async onModuleDestroy(): Promise<void> {
    await this.store.close();
  }
}

@Module({
  providers: [
    { provide: COUNTER_STORE, useFactory: (): CounterStore => createCounterStore() },
    { provide: LIMITS_DB, useFactory: (): Db => createDb(createPool()) },
    // Exported so the auth limiter can be constructed inside `AuthModule`, which
    // imports this one. `AppModule` provides the same token for everything else;
    // the factory is shared so both are the same kind of logger, and the DI
    // bargain ADR-15 buys — a test swaps the sink by overriding one provider —
    // holds in both places.
    { provide: LOGGER, useFactory: apiLogger },
    CounterStoreLifecycle,
  ],
  exports: [COUNTER_STORE, LIMITS_DB, LOGGER],
})
export class LimitsModule {}
