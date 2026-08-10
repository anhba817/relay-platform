import { Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";

import { createLogger } from "@relay/service-kit";

import { createRecorder } from "./recorder";
import { createConsumerRuntime, type ConsumerRuntime } from "./runtime";

// The consumer's home (chapter 3.4). It runs INSIDE the api service, and that
// is a constraint rather than a convenience.
//
// Its deduplication ledger is a Postgres write, and ADR-04 makes the api the
// only service that writes to Postgres — the SAD applies that strictly enough
// that the media worker transitions state through an internal route precisely
// so it never touches the database. A consumer deployed as its own service
// would be a second writer.
//
// So it sits here, exactly as chapter 3.3's outbox relay does under ADR-06's
// "a small loop inside the API service initially, promotable to its own
// deployment". What that costs is named rather than discovered: chapter 3.5's
// dispatcher IS meant to be its own service, and it will need either an
// internal route for its ledger or an explicit ADR amendment (research R5).

export const EVENT_CONSUMER = "EVENT_CONSUMER";

/** The durable name. It is a POSITION in the stream, shared by every instance
 * using it — which is what lets two api processes divide the work instead of
 * each receiving everything (research R8). */
export const RECORDER_DURABLE = "recorder";

/** On by default: an event spine nobody reads is what chapter 3.3 left behind.
 * `RELAY_EVENT_CONSUMER=off` exists for suites that want a quiet database —
 * 3.3 learned the hard way that a background loop mutating a table two other
 * test files assert on is a race between test files, not a property. */
export function consumerEnabled(): boolean {
  return (process.env.RELAY_EVENT_CONSUMER ?? "on").toLowerCase() !== "off";
}

@Injectable()
export class EventConsumerService implements OnModuleDestroy {
  constructor(@Inject(EVENT_CONSUMER) private readonly runtime: ConsumerRuntime) {}

  start(): void {
    if (consumerEnabled()) this.runtime.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.runtime.stop();
  }
}

@Module({
  providers: [
    {
      provide: EVENT_CONSUMER,
      useFactory: (): ConsumerRuntime => {
        const logger = createLogger("consumer");
        return createConsumerRuntime({
          durable: RECORDER_DURABLE,
          handler: createRecorder(logger),
          logger,
        });
      },
    },
    EventConsumerService,
  ],
  exports: [EVENT_CONSUMER, EventConsumerService],
})
export class ConsumerModule {}
