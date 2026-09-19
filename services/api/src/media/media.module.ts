import { Module, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";

import { AuthModule } from "../auth/auth.module";
import { createDb, createPool, type Db } from "../db/client";
import { Repository } from "../db/repository";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";
import type { RequestWithTenant } from "../messages/request-with-tenant";

// Hosted media's module (FR-MED-01, FR-MED-02).
//
// REGISTERED IN `app.module.ts`, WHICH IS A TASK NO REQUIREMENT NAMES. Without that
// line the route does not exist and every test in this chapter gets a 404 that reads
// as a routing bug. Chapter 4.6 shipped the same omission in the tutorial's manifest
// and `pnpm build` said `Error: Unknown chapter id: 4.6`; its record reads
// *"registering the chapter is a task no requirement had named"*.
//
// AND THE REPOSITORY IS PROVIDED HERE, PER MODULE, which is this api's shape rather
// than this chapter's choice — `users`, `channels` and `webhooks` each carry the same
// two providers. A module that declares a service without them compiles, typechecks
// and lints, and fails at the first request with `Nest can't resolve dependencies of
// the MediaService (?)`. **Only a running app asks the question.**
//
// REQUEST-SCOPED, because the environment id comes off the principal the guard put on
// this request. A default-scoped repository would be built once, at boot, against
// whichever tenant happened to be first — constitution I broken by a lifetime.
@Module({
  imports: [AuthModule],
  controllers: [MediaController],
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
    MediaService,
  ],
})
export class MediaModule {}
