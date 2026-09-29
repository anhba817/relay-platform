import { Module, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";

import { AuthModule } from "../auth/auth.module";
import { LOGGER, apiLogger } from "../logger";
import { ensureAnalyticsStream } from "../outbox/jetstream.publisher";
import { createJetStreamPublisher } from "../outbox/jetstream.publisher";
import type { Publisher } from "../outbox/publisher";
import { ANALYTICS_PUBLISHER } from "../webhooks/analytics";
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
    // A THIRD COPY OF THE SAME FACTORY, AND THE RULE THAT FORCES IT IS WRITTEN IN
    // `internal.module.ts`: *"a provider is visible to the module that declares it and to
    // nothing it imports"* — and `InternalModule` has no `exports:` array. `AppModule`
    // already provides `ANALYTICS_PUBLISHER` for its middleware and `InternalModule` for
    // the dispatcher; this module needs it for FR-MED-12's storage deltas (4.16).
    //
    // The cost is the one `app.module.ts` states: another lazy NATS connection and another
    // idempotent `ensureAnalyticsStream` at boot. **And declaring a service without its
    // providers compiles, typechecks and lints**, then fails at the first request with
    // `Nest can't resolve dependencies` — 4.10's finding, in this very file's header.
    {
      provide: ANALYTICS_PUBLISHER,
      useFactory: (): Publisher => createJetStreamPublisher({ ensure: ensureAnalyticsStream }),
    },
    { provide: LOGGER, useFactory: () => apiLogger() },
    MediaService,
  ],
})
export class MediaModule {}
