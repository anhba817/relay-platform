import { Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";

import { createLogger } from "@relay/service-kit";

import { createDb, createPool, type Db } from "../db/client";
import { createMailer } from "./mailer";
import {
  createNotificationRelay,
  type NotificationRelay,
} from "./notification-relay";

// The notification relay's home (chapter 3.8). Same shape as the outbox
// module's, deliberately: a loop that reads a table, does a side effect, and
// shares no state with the request path — so promoting it out of this service
// would mean moving this file and nothing else.

export const NOTIFICATION_RELAY = "NOTIFICATION_RELAY";

/** Off for the suites that want a quiet database, on everywhere else. Same
 * switch and same reasoning as `RELAY_OUTBOX_RELAY`: most integration tests
 * assert on rows, and a background loop marking them delivered mid-assertion is
 * a race between test files rather than a property of the system.
 *
 * FLAPPING IS NOT SOLVED HERE, and is worth naming rather than discovering. An
 * endpoint that is disabled, re-enabled and disabled again produces two rows and
 * two emails, and nothing collapses them — the spec's own edge case says neither
 * must suppress the other, because a second outage really is a second thing to
 * be told about. An endpoint flapping hourly therefore sends hourly. Solving it
 * means a notification-preferences model, which is product. */
export function notificationRelayEnabled(): boolean {
  return (
    (process.env.RELAY_NOTIFICATION_RELAY ?? "on").toLowerCase() !== "off"
  );
}

@Injectable()
export class NotificationRelayService implements OnModuleDestroy {
  constructor(
    @Inject(NOTIFICATION_RELAY) private readonly relay: NotificationRelay,
  ) {}

  start(): void {
    if (notificationRelayEnabled()) this.relay.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.relay.stop();
  }
}

@Module({
  providers: [
    {
      provide: NOTIFICATION_RELAY,
      useFactory: (): NotificationRelay =>
        createNotificationRelay({
          db: createDb(createPool()) as Db,
          mailer: createMailer(),
          logger: createLogger("notifications"),
        }),
    },
    NotificationRelayService,
  ],
  exports: [NOTIFICATION_RELAY, NotificationRelayService],
})
export class NotificationsModule {}
