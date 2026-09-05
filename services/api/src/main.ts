import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { createLogger } from "@relay/service-kit";

import { AppModule } from "./app.module";
import { EventConsumerService } from "./consumer/consumer.module";
import { NotificationRelayService } from "./notifications/notifications.module";
import { QuotaRelayService } from "./quotas/quotas.module";
import { OutboxRelayService } from "./outbox/outbox.module";
import { DeliveryRelayService } from "./webhooks/webhooks.module";

// Nest's own banner logger stays off: this workspace already decided what a
// log line looks like (one JSON object, NFR-OBS-01), and the framework does
// not get a second opinion.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  // The relay starts AFTER the server is listening, and starting it cannot
  // fail: the publisher connects lazily, so an unreachable broker leaves events
  // accumulating in Postgres instead of preventing the api from serving writes
  // (chapter 3.3, research R9).
  app.get(OutboxRelayService).start();
  // Chapter 3.8: the disablement notifications chapter 3.6 wrote and nothing
  // delivered. Its backlog drains on this first start as ordinary undelivered
  // work — no migration and no special case, because `delivered_at IS NULL` was
  // already true of every one of those rows.
  app.get(NotificationRelayService).start();
  app.get(QuotaRelayService).start();
  // And the second relay (chapter 3.5): the same loop over a different table,
  // publishing deliveries that have become due. Started here for 3.3's reason —
  // a retry schedule that only runs when someone remembers is not a schedule.
  app.get(DeliveryRelayService).start();
  // And the first thing that reads what the relay publishes (chapter 3.4).
  // Same placement, same reason, same lazy connection: an unreachable broker
  // leaves the api serving writes.
  app.get(EventConsumerService).start();
  // Nest calls onModuleDestroy on shutdown hooks; without this the relay's loop
  // would outlive the process's intent to stop.
  app.enableShutdownHooks();
  // THE PORT IT BOUND, NOT THE ONE IT ASKED FOR (feature 043, FR-002). `port` is the
  // REQUEST — `Number(process.env.PORT ?? 4000)` — and with `PORT=0` the operating system
  // assigns an ephemeral one, so this line used to report `0` while the server listened
  // somewhere else. A log that states a requested value as though it were the assigned one
  // is wrong whether or not anybody reads it; that it also makes `PORT=0` usable by a test
  // harness is the second reason, not the first.
  const bound = (app.getHttpServer() as { address(): { port: number } | string | null })
    .address();
  createLogger("api").log("info", "listening", {
    port: typeof bound === "object" && bound !== null ? bound.port : port,
  });
}

void bootstrap();
