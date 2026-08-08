import { Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";

import { createLogger } from "@relay/service-kit";

import { createDb, createPool, type Db } from "../db/client";
import { createJetStreamPublisher } from "./jetstream.publisher";
import { createRelay, type Relay } from "./relay";

// The relay's home (chapter 3.3). It lives INSIDE the api service because
// ADR-06 put it there — "a small loop inside the API service initially,
// promotable to its own deployment if outbox depth alarms fire". Promoting it
// would mean moving this file and nothing else: the loop reads a table and
// writes to a broker, and shares no state with the request path.

export const OUTBOX_RELAY = "OUTBOX_RELAY";

/** The relay runs WITH the service. It is not something an operator switches
 * on — an event spine that only runs when someone remembers is not a spine.
 *
 * `RELAY_OUTBOX_RELAY=off` exists for the suites that want a quiet database:
 * most integration tests assert on rows, and a background loop marking them
 * published mid-assertion would make those tests flaky for no teaching value.
 * The outbox suite turns it off and drives `drainOnce()` itself, which is the
 * same code path the loop runs. */
export function relayEnabled(): boolean {
  return (process.env.RELAY_OUTBOX_RELAY ?? "on").toLowerCase() !== "off";
}

@Injectable()
export class OutboxRelayService implements OnModuleDestroy {
  constructor(@Inject(OUTBOX_RELAY) private readonly relay: Relay) {}

  start(): void {
    if (relayEnabled()) this.relay.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.relay.stop();
  }
}

@Module({
  providers: [
    {
      provide: OUTBOX_RELAY,
      useFactory: (): Relay =>
        createRelay({
          db: createDb(createPool()) as Db,
          publisher: createJetStreamPublisher(),
          logger: createLogger("outbox"),
        }),
    },
    OutboxRelayService,
  ],
  exports: [OUTBOX_RELAY, OutboxRelayService],
})
export class OutboxModule {}
