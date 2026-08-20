import { Module } from "@nestjs/common";

import { createDb, createPool, type Db } from "../db/client";
import { LimitsModule } from "../limits/limits.module";
import { AuthLimiter } from "../limits/auth-limiter";
import { AUTH_DB, AuthenticateMiddleware } from "./authenticate.middleware";
import { CredentialGuard } from "./credential.guard";
import { DevTokenController } from "./dev-token.controller";

// Authentication's home (chapter 3.2), beside messages/, internal/ and
// tenancy/. It lives in the api and not in a package or a new service for one
// reason: authentication is a question about data — which key is this, which
// environment signs that token — and the api owns the data (ADR-04). The
// gateway's share of the work is one call it was already making (research R1).
//
// The DB handle is its own provider rather than MessagesModule's: this module
// runs BEFORE any tenant scope exists, and borrowing the request-scoped
// machinery 2.2 built would invert the order it needs.
@Module({
  // Chapter 3.8: the failed-authentication counter. Imported rather than built
  // here, because the counter store is one client with one lifecycle and two
  // consumers — this module and the tenant limiter's middleware.
  imports: [LimitsModule],
  controllers: [DevTokenController],
  providers: [
    { provide: AUTH_DB, useFactory: (): Db => createDb(createPool()) },
    AuthLimiter,
    AuthenticateMiddleware,
    CredentialGuard,
  ],
  exports: [AUTH_DB, AuthenticateMiddleware, CredentialGuard, AuthLimiter],
})
export class AuthModule {}
