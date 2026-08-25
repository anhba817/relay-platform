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
import { environmentSigningSecret, Repository } from "../db/repository";
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
    // The guard above already refused anything but an API key, so this is
    // unreachable — but chapter 3.5 added a third principal kind that carries no
    // environment at all, and an assumption the compiler cannot see is one a
    // later refactor can quietly break. Narrowing here costs a line and makes
    // `@Accepts("application")` a fact rather than a promise.
    if (principal.kind !== "application") {
      throw new BadRequestException("an API key is required");
    }
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

    // ── THE USER ROW, CREATED IF ABSENT (chapter 3.15, FR-039a, FR-039b) ────
    //
    // FR-USR-02: "a user record shall be created implicitly on first
    // authentication if it does not exist." Nothing did it, and the gap had a
    // symptom: mint a token for an identifier with no row, send through
    // `POST /internal/messages`, and the api answered **`400 "unknown user"`** — a
    // message that names the caller rather than the cause, which is exactly what
    // implicit creation exists to prevent.
    //
    // CHAPTER 3.13'S IDEMPOTENT `createUser`, and that is the whole implementation.
    // It is `ON CONFLICT DO NOTHING` on `(environment_id, external_id)`, so
    // authentication and membership converge on one row for one identifier no
    // matter which arrives first, and a second mint creates nothing.
    //
    // AND THE RESPONSE DOES NOT SAY WHICH HAPPENED. A status or field
    // distinguishing "created" from "existed" would be a membership oracle: a
    // caller could enumerate which external ids a tenant has by minting tokens
    // and reading the answer. The token is the answer either way.
    //
    // IT ALSO CANNOT LIFT A BAN OR A DELETION. `createUser` touches no column on
    // an existing row — its own comment is about refusing to rename anybody — so
    // `banned_at` and `deleted_at` survive a mint. `upsertUser` is the route that
    // clears state, and it clears only `deleted_at`, because FR-030 asks it to.
    // A BOT CANNOT OBTAIN A TOKEN (chapter 3.17, FR-005, T040, T041).
    //
    // `createUser` still creates a PERSON for an unknown identifier — FR-005a, and the
    // paragraph above is why that matters — so this refusal is only ever about a row
    // that already exists and is already software. A bot is an identity messages are
    // sent AS, not an account that logs in, and a token is the one thing that would make
    // it the second.
    //
    // 404 `not_found`, AND THERE IS NO INDISTINGUISHABLE ANSWER AVAILABLE. Everywhere
    // else in this chapter a refusal is made byte-identical to the refusal for an
    // identifier that exists nowhere — but on this route an unknown identifier answers
    // **200 with a token**, because chapter 3.16 made the mint create the row. So there
    // is nothing for a refusal to be identical to: any refusal at all says "this
    // identifier exists and is not a person". That is a leak this route cannot close,
    // and 404 is chosen because it is the answer this route already gives for an
    // environment it cannot resolve — one shape rather than a new one (FR-005).
    const repo = new Repository(this.db, principal.environmentId);
    const existing = await repo.getUserByExternalId(body.user);
    if (existing?.kind === "bot") {
      throw new NotFoundException({
        code: "not_found",
        message: "no such user",
      });
    }
    await repo.createUser(body.user);

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
