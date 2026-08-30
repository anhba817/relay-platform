import {
  Controller,
  Get,
  HttpCode,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import type { InternalMembershipsResponse } from "@relay/protocol";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { RequestWithPrincipal } from "../auth/principal";
import { Repository } from "../db/repository";

// `GET /internal/memberships` (chapter 3.20, FR-017) — REVIVED, not invented.
//
// `internalMembershipsResponseSchema` has been exported from
// `packages/protocol/src/internal.ts` since chapter 3.2 and parsed by nothing. The
// route it described was replaced that chapter by `POST /internal/session`, which
// answers identity and memberships in one call at connect — and the schema stayed,
// with `internalSessionResponseSchema`'s comment two lines below saying it "replaces
// the memberships response above rather than joining it".
//
// **The backstop needs the question this schema asks and not the one `session` asks.**
// A periodic re-read wants "what may this connection hear, now"; it does not want a
// fresh identity, a fresh quota decision, a fresh connect policy, or the 402 that
// `session` can throw when an environment is over its connection allowance. Reusing
// `session` for the re-read would make a routine refresh capable of failing for a
// reason that has nothing to do with membership, on a path whose entire job is to be
// unremarkable.
//
// WHY IT IS A GET when `session` is a POST. `session` presents a credential for
// verification and NFR-SEC-06 forbids a credential in a URL; this presents one in the
// Authorization header like every other route and reads nothing else. It is a read
// with no body, so it is a GET.
//
// **GET-ONLY IS LOAD-BEARING.** `services/api/src/tenancy/signup.itest.ts:285` POSTs
// this path with no credential and asserts the status is not 200 and the body carries
// no `organisation`. A GET-only route answers a POST with 404, so that assertion
// stands. Registering `ALL`, adding a POST twin, or answering an unauthenticated
// caller is what would break it — checked as a premise before this file was written,
// because research R4's first draft claimed the revival would break it and was wrong.
@Controller("internal")
@Accepts("user")
@UseGuards(CredentialGuard)
export class MembershipsController {
  constructor(private readonly repo: Repository) {}

  @Get("memberships")
  @HttpCode(200)
  async memberships(
    @Req() req: RequestWithPrincipal,
  ): Promise<InternalMembershipsResponse> {
    const principal = req.principal;
    // The guard has already refused an absent, invalid or wrong-class credential,
    // so reaching here with anything else is a wiring fault rather than a client
    // error — `session.controller.ts` says the same about its own narrowing.
    if (principal?.kind !== "user") {
      throw new UnauthorizedException("a verified end-user token is required");
    }

    // A verified token for a user this environment has never seen is a user with no
    // channels, not an error. 2.5's rule, and the backstop depends on it: a re-read
    // that threw for a deleted user would turn a routine refresh into a failure the
    // gateway has to interpret.
    const user = await this.repo.getUserByExternalId(principal.userExternalId);
    return {
      channel_ids: user ? await this.repo.channelsForUser(user.id) : [],
    };
  }
}
