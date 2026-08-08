import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import type { Db } from "../db/client";
import { environmentSigningSecret } from "../db/repository";
import { AUTH_DB } from "./authenticate.middleware";
import { Accepts, CredentialGuard } from "./credential.guard";
import type { RequestWithPrincipal } from "./principal";
import { MAX_TOKEN_LIFETIME_SECONDS, mintUserToken } from "./user-token";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";

// FR-AUT-09: the development-only endpoint that turns an API key into an
// end-user token. It exists so a developer reaches a first authenticated
// message before writing any token-signing code of their own — the alternative
// being a quickstart that starts with "implement JWT minting".
//
// The signing secret never leaves the api, which is the same reason the gateway
// asks rather than verifies (research R1): a per-environment secret handed to a
// second process is a secret in two places.

const devTokenRequestSchema = z.object({
  user: z.string().min(1),
  ttl_seconds: z.number().int().positive().max(MAX_TOKEN_LIFETIME_SECONDS).optional(),
});

type DevTokenRequest = z.infer<typeof devTokenRequestSchema>;

const DEFAULT_TTL_SECONDS = 3600;

@Controller("auth")
export class DevTokenController {
  constructor(@Inject(AUTH_DB) private readonly db: Db) {}

  @Post("dev-token")
  // 200, not Nest's default 201 for a POST: nothing was created. The token is
  // derived from a key that already existed, and the contract says 200.
  @HttpCode(200)
  // An API key and nothing else. A route that minted end-user tokens from an
  // end-user token would let a leaked token extend itself indefinitely, and no
  // requirement asks for it (research R8's rejected alternative, same shape).
  @Accepts("application")
  @UseGuards(CredentialGuard)
  async mint(
    @Body(new ZodValidationPipe(devTokenRequestSchema)) body: DevTokenRequest,
    @Req() req: RequestWithPrincipal,
  ): Promise<{ token: string; expires_at: string }> {
    const principal = req.principal!;
    const environment = await environmentSigningSecret(
      this.db,
      principal.environmentId,
    );
    if (!environment) throw new BadRequestException("unknown environment");

    // 404 and not 403, deliberately (contracts). This is not a permission the
    // caller lacks — it is a development affordance that does not exist in
    // production, and a 403 would invite someone to go looking for the
    // permission that would unlock it.
    if (environment.kind !== "development") {
      throw new NotFoundException("Cannot POST /auth/dev-token");
    }

    const { token, expiresAt } = await mintUserToken(environment.signingSecret, {
      user: body.user,
      environmentId: principal.environmentId,
      ttlSeconds: body.ttl_seconds ?? DEFAULT_TTL_SECONDS,
    });
    // snake_case on the wire, camelCase inside — the same boundary rule every
    // other response in this service follows.
    return { token, expires_at: expiresAt };
  }
}
