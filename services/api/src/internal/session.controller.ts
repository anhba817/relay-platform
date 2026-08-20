import {
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import type { InternalSessionResponse } from "@relay/protocol";

import { AUTH_DB } from "../auth/authenticate.middleware";
import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { RequestWithPrincipal } from "../auth/principal";
import type { Db } from "../db/client";
import { environmentLimits, Repository } from "../db/repository";
import { DEFAULT_LIMITS } from "../limits/policy";

// `POST /internal/session` (chapter 3.2) — the route that replaced
// `GET /internal/memberships`.
//
// It answers the gateway's only question at connect: who is this, and what may
// they hear? Both halves used to be answered in two different places — the
// gateway verified the token locally and then asked the api for memberships.
// Now the api does both, in the call the gateway was already making, so the
// connect path costs exactly what it cost before (research R1).
//
// WHY IT IS A POST when it reads nothing: it presents a credential for
// verification, and a credential does not belong in a URL — NFR-SEC-06 forbids
// exactly that. The token arrives in the Authorization header like everywhere
// else in this api; the POST is about not having a cacheable, loggable GET of a
// credential-bearing request.
@Controller("internal")
@Accepts("user")
@UseGuards(CredentialGuard)
export class SessionController {
  constructor(
    @Inject(AUTH_DB) private readonly db: Db,
    private readonly repo: Repository,
  ) {}

  @Post("session")
  // 200: nothing is created. The POST is about keeping a credential out of a
  // URL, not about creating a resource (contracts).
  @HttpCode(200)
  async session(
    @Req() req: RequestWithPrincipal,
  ): Promise<InternalSessionResponse> {
    const principal = req.principal;
    // The guard has already refused an absent, invalid or wrong-class
    // credential, so reaching here with anything else is a wiring fault rather
    // than a client error.
    if (principal?.kind !== "user") {
      throw new UnauthorizedException("a verified end-user token is required");
    }

    const user = await this.repo.getUserByExternalId(principal.userExternalId);
    // A verified token for a user this environment has never seen is not an
    // error: it is a user with no channels. The gateway's job is delivery, not
    // identity forensics — 2.5's rule, and the reason a first connect from a
    // brand-new user works before anything is seeded.
    // Chapter 3.8: the gateway's limits, resolved here because the gateway has no
    // database and must not gain one (research R12). Null columns are already
    // defaults by the time they leave the repository, so the gateway never has to
    // know that "no override" is a state.
    const limits = await environmentLimits(this.db, principal.environmentId);
    return {
      environment_id: principal.environmentId,
      user: principal.userExternalId,
      channel_ids: user ? await this.repo.channelsForUser(user.id) : [],
      limits: {
        connect: limits?.connect ?? DEFAULT_LIMITS.connect,
        send: limits?.send ?? DEFAULT_LIMITS.send,
      },
    };
  }
}
