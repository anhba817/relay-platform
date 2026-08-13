import {
  Inject,
  Injectable,
  Module,
  Scope,
  type OnModuleDestroy,
} from "@nestjs/common";
import { REQUEST } from "@nestjs/core";

import { createLogger } from "@relay/service-kit";

import { AuthModule } from "../auth/auth.module";
import { createDb, createPool, type Db } from "../db/client";
import { Repository } from "../db/repository";
import type { RequestWithTenant } from "../messages/request-with-tenant";
import { createJetStreamPublisher } from "../outbox/jetstream.publisher";
import {
  createDeliveryRelay,
  ensureDeliveriesStream,
  type DeliveryRelay,
} from "./delivery-relay";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

export const DELIVERY_RELAY = "DELIVERY_RELAY";

/** The api's SECOND relay (chapter 3.5, research R13), started with the service
 * exactly as 3.3's is. An event spine that only runs when someone remembers is
 * not a spine, and the same is true of a retry schedule.
 *
 * `RELAY_DELIVERY_RELAY=off` is the sibling of `RELAY_OUTBOX_RELAY=off`, and it
 * exists for the same reason: suites that assert on delivery rows would flap if
 * a background loop marked them dispatched mid-assertion. Chapter 3.3's finding
 * 4 — a background daemon and a test lane do not share a table quietly — applies
 * again, and this time it is anticipated rather than discovered. */
export function deliveryRelayEnabled(): boolean {
  return (process.env.RELAY_DELIVERY_RELAY ?? "on").toLowerCase() !== "off";
}

@Injectable()
export class DeliveryRelayService implements OnModuleDestroy {
  constructor(@Inject(DELIVERY_RELAY) private readonly relay: DeliveryRelay) {}

  start(): void {
    if (deliveryRelayEnabled()) this.relay.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.relay.stop();
  }
}

// The same wiring chapter 2.2 established and 3.2 re-pointed: the repository is
// the plain class, constructed per request with the environment the middleware
// resolved from a verified credential. A request cannot name a tenant it has not
// proved it may act for, and this module adds no new way to try.
@Module({
  imports: [AuthModule],
  controllers: [WebhooksController],
  providers: [
    {
      provide: "DB",
      useFactory: (): Db => createDb(createPool()),
      scope: Scope.DEFAULT,
    },
    {
      provide: Repository,
      scope: Scope.REQUEST,
      inject: ["DB", REQUEST],
      useFactory: (db: Db, req: RequestWithTenant) =>
        new Repository(db, req.principal?.environmentId ?? ""),
    },
    WebhooksService,
    {
      provide: DELIVERY_RELAY,
      useFactory: (): DeliveryRelay =>
        createDeliveryRelay({
          db: createDb(createPool()) as Db,
          // Its OWN stream, not the events one. Chapter 3.3's publisher
          // ensured EVENTS because that was the only stream; this one must
          // bring DELIVERIES into existence or every publish is a 503.
          publisher: createJetStreamPublisher({ ensure: ensureDeliveriesStream }),
          logger: createLogger("deliveries"),
        }),
    },
    DeliveryRelayService,
  ],
  exports: [DELIVERY_RELAY, DeliveryRelayService],
})
export class WebhooksModule {}
