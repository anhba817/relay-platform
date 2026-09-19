import { Module } from "@nestjs/common";

import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";

// Hosted media's module (FR-MED-01, FR-MED-02).
//
// REGISTERED IN `app.module.ts`, WHICH IS A TASK NO REQUIREMENT NAMES. Without that
// line the route does not exist and every test in this chapter gets a 404 that reads
// as a routing bug. Chapter 4.6 shipped the same omission in the tutorial's manifest
// and `pnpm build` said `Error: Unknown chapter id: 4.6`; its record reads
// *"registering the chapter is a task no requirement had named"*.
@Module({
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
