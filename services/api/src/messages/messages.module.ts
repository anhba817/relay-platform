import {
  Inject,
  Injectable,
  Module,
  Scope,
  type OnModuleDestroy,
} from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { Logger } from "@relay/service-kit";

import { AuthModule } from "../auth/auth.module";
import {
  createMessagePublisher,
  type MessagePublisher,
} from "../fanout/publisher";
import { apiLogger, LOGGER } from "../logger";
import { createDb, createPool, type Db } from "../db/client";
import type { RequestWithTenant } from "./request-with-tenant";
import { Repository } from "../db/repository";
import { MessagesController } from "./messages.controller";
import { MessagesService } from "./messages.service";

/** Chapter 3.18. The api publishes to the live fan-out from the send path, so
 * the module that owns that path owns the client.
 *
 * PROVIDED AND NOT EXPORTED, and that is the point. `internal.module.ts` imports
 * this module and, in its own words, "reuse[s] MessagesModule's providers
 * wholesale" — so an exported publisher would be injectable from the internal
 * route, which is the one path that must never publish. The gateway already
 * publishes for a socket send, and a second publisher there would put the same
 * message on every member's screen twice (FR-006).
 *
 * Withholding it makes that structural rather than a matter of where a call
 * sits. This module already does the same with `"DB"`. */
export const MESSAGE_PUBLISHER = "MESSAGE_PUBLISHER";

/** `limits/limits.module.ts:10` states the convention: "resource in this api
 * closes through `OnModuleDestroy`". Six modules implement it; this is
 * `CounterStoreLifecycle` for the analogous Redis client. A `close()` nothing
 * calls is a leaked handle in a service that boots once per integration
 * suite. */
@Injectable()
export class MessagePublisherLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(MESSAGE_PUBLISHER) private readonly publisher: MessagePublisher,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.publisher.close();
  }
}

// The repository stays the plain 2.1 class — the framework's job is only
// to construct it per request with the authenticated tenant (ADR-15's
// scope note: guards authenticate, the data layer isolates).
@Module({
  imports: [AuthModule],
  controllers: [MessagesController],
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
        // The FACTORY reads the PRINCIPAL, not the guard's leftovers: Nest
        // resolves request-scoped providers BEFORE the enhancer chain
        // runs, so anything a guard stashes on the request is invisible
        // here. Middleware runs earlier still, which is why chapter 3.2
        // authenticates there (research R5, measured in T004).
        //
        // Chapter 3.2 changed WHERE the environment comes from and nothing
        // else about this line. It used to be an environment header — a
        // header any caller could type. It is now the environment resolved
        // from a verified credential, so a request cannot name a tenant it
        // has not proved it may act for. The empty-string fallback is the
        // same as 2.2's: no principal means no scope, and the guard below
        // turns that into a 401 before any handler runs.
        new Repository(db, req.principal?.environmentId ?? ""),
    },
    MessagesService,
    { provide: LOGGER, useFactory: apiLogger },
    {
      provide: MESSAGE_PUBLISHER,
      inject: [LOGGER],
      useFactory: (logger: Logger): MessagePublisher =>
        createMessagePublisher({ logger }),
    },
    MessagePublisherLifecycle,
  ],
  // MESSAGE_PUBLISHER is deliberately absent. See the note above it.
  exports: [Repository, MessagesService],
})
export class MessagesModule {}
