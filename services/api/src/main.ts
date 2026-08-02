import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { createLogger } from "@relay/service-kit";

import { AppModule } from "./app.module";

// Nest's own banner logger stays off: this workspace already decided what a
// log line looks like (one JSON object, NFR-OBS-01), and the framework does
// not get a second opinion.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  createLogger("api").log("info", "listening", { port });
}

void bootstrap();
