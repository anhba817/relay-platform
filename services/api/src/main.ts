import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { createLogger } from "@relay/service-kit";

import { AppModule } from "./app.module";
import { EventConsumerService } from "./consumer/consumer.module";
import { OutboxRelayService } from "./outbox/outbox.module";
import { DeliveryRelayService } from "./webhooks/webhooks.module";

// Nest's own banner logger stays off: this workspace already decided what a
// log line looks like (one JSON object, NFR-OBS-01), and the framework does
// not get a second opinion.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const requested = Number(process.env.PORT ?? 4000);
  await app.listen(requested);
  // THE PORT IT GOT, NOT THE PORT IT ASKED FOR.
  //
  // `PORT=0` asks the operating system for any free port, which is what a test spawning
  // this service should do — a fixed port races whichever sibling suite also binds one,
  // and a previous run's child still holding it makes a health check succeed against a
  // service that has never heard of this run's data. Three unrelated-looking assertions,
  // one fixture.
  //
  // But a parent can only use the number if this process reports it, and logging
  // `requested` prints 0. So the bound address is read back and logged.
  const address = app.getHttpServer().address() as { port?: number } | string | null;
  const port =
    typeof address === "object" && address !== null ? (address.port ?? requested) : requested;
  // The relay starts AFTER the server is listening, and starting it cannot fail: the
  // publisher connects lazily, so an unreachable broker leaves events accumulating in
  // Postgres instead of preventing the api from serving writes (research R9).
  app.get(OutboxRelayService).start();
  // And the second relay: the same loop over a different table,
  // publishing deliveries that have become due. Started here for the outbox chapter's reason —
  // a retry schedule that only runs when someone remembers is not a schedule.
  app.get(DeliveryRelayService).start();
  // And the first thing that reads what the relay publishes.
  // Same placement, same reason, same lazy connection: an unreachable broker
  // leaves the api serving writes.
  app.get(EventConsumerService).start();
  // Nest calls onModuleDestroy on shutdown hooks; without this the relay's loop
  // would outlive the process's intent to stop.
  app.enableShutdownHooks();
  createLogger("api").log("info", "listening", { port });
}

void bootstrap();
