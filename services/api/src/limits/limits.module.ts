import { Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";

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
    CounterStoreLifecycle,
  ],
  exports: [COUNTER_STORE],
})
export class LimitsModule {}
