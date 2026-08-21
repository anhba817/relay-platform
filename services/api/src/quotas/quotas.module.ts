import { Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";

import { createLogger } from "@relay/service-kit";

import { createDb, createPool, type Db } from "../db/client";
import { createMailer } from "../notifications/mailer";
import { createQuotaRelay, type QuotaRelay } from "./quota-relay";

// The quota relay's home (chapter 3.10). Same shape as the notification
// module's, which is the same shape as the outbox module's: a loop that reads a
// table, does a side effect, and shares no state with the request path.

export const QUOTA_RELAY = "QUOTA_RELAY";

/** Off for the suites that want a quiet database, on everywhere else — the same
 * switch and the same reasoning as `RELAY_NOTIFICATION_RELAY`. Feature 030's R39
 * found nine suites booting `AppModule` with every relay defaulting on, so the
 * three lane configs that carry the other flags carry this one too. */
export function quotaRelayEnabled(): boolean {
  return (process.env.RELAY_QUOTA_RELAY ?? "on").toLowerCase() !== "off";
}

@Injectable()
export class QuotaRelayService implements OnModuleDestroy {
  constructor(@Inject(QUOTA_RELAY) private readonly relay: QuotaRelay) {}

  start(): void {
    if (quotaRelayEnabled()) this.relay.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.relay.stop();
  }
}

@Module({
  providers: [
    {
      provide: QUOTA_RELAY,
      useFactory: (): QuotaRelay =>
        createQuotaRelay({
          db: createDb(createPool()) as Db,
          mailer: createMailer(),
          logger: createLogger("quotas"),
        }),
    },
    QuotaRelayService,
  ],
  exports: [QUOTA_RELAY, QuotaRelayService],
})
export class QuotasModule {}
