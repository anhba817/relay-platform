import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { createLogger } from "@relay/service-kit";

import { AppModule } from "./app.module";
import { OutboxRelayService } from "./outbox/outbox.module";

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
  // Nest calls onModuleDestroy on shutdown hooks; without this the relay's loop
  // would outlive the process's intent to stop.
  app.enableShutdownHooks();
  createLogger("api").log("info", "listening", { port });
}

void bootstrap();
