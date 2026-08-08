import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { createDb, createPool } from "../db/client";
import { provisionOrganisation } from "../db/repository";
import {
  authorizeUrl,
  exchangeCodeForProfile,
  providerConfig,
  ProviderError,
} from "./oauth.provider";
import {
  STATE_COOKIE,
  clearStateCookie,
  mintState,
  readCookie,
  stateCookie,
  statesMatch,
} from "./state-cookie";

// Signup (chapter 3.1, FR-TEN-01/02). Two routes, both necessarily
// unauthenticated: they exist to establish who somebody is, and no tenant
// exists yet for a header to name. Note what is absent — the
// EnvironmentContextGuard every other controller carries (2.2). The guard is
// applied per controller, so a pre-tenant route simply does not use it, and
// the seam it guards is untouched by this chapter (3.2 retires it).
//
// What these routes do NOT do: issue a session. A session is a credential,
// credentials are 3.2's subject, and the dashboard that would consume one is
// Part 5. The callback reports what it created — and, from 3.2, hands over the
// environment's first API key, because with no session nothing else could
// bootstrap one (research R8).

/** The two things this controller needs from the response object.
 *
 * `@Res()` puts a handler in Nest's library-specific mode, which normally
 * means importing express's `Response` type — and express 5 ships no types, so
 * that would mean adding `@types/express` for two method signatures. Declaring
 * the shape instead keeps the api's dependency list exactly where 1.4 left it,
 * and states plainly what these routes actually touch. */
interface HttpResponse {
  setHeader(name: string, value: string): void;
  redirect(status: number, url: string): void;
}

const db = createDb(createPool());

@Controller("auth")
export class SignupController {
  @Get(":provider/start")
  start(@Param("provider") provider: string, @Res() res: HttpResponse): void {
    const config = providerConfig(provider);
    // An unconfigured or unknown provider is a 404 — never a redirect built
    // from unvalidated input.
    if (!config) throw new NotFoundException("unknown provider");

    const state = mintState();
    const secure = !(
      process.env.RELAY_OAUTH_REDIRECT_BASE ?? "http://localhost:4000"
    ).startsWith("http://");
    res.setHeader("set-cookie", stateCookie(state, secure));
    res.redirect(302, authorizeUrl(provider, config, state));
  }

  @Get(":provider/callback")
  async callback(
    @Param("provider") provider: string,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") providerError: string | undefined,
    @Headers("cookie") cookieHeader: string | undefined,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const config = providerConfig(provider);
    if (!config) throw new NotFoundException("unknown provider");

    const secure = !(
      process.env.RELAY_OAUTH_REDIRECT_BASE ?? "http://localhost:4000"
    ).startsWith("http://");

    // THE BINDING IS CHECKED FIRST, before anything else is even read. An
    // unverified callback must never make this server talk to the provider on
    // an attacker's behalf — and a state that merely validates as
    // well-formed proves nothing about WHICH browser began the flow.
    const expected = readCookie(cookieHeader, STATE_COOKIE);
    if (!statesMatch(state, expected)) {
      res.setHeader("set-cookie", clearStateCookie(secure));
      throw new BadRequestException("state does not match");
    }
    res.setHeader("set-cookie", clearStateCookie(secure));

    if (providerError) throw new BadRequestException(providerError);
    if (!code) throw new BadRequestException("missing code");

    let profile;
    try {
      profile = await exchangeCodeForProfile(provider, config, code);
    } catch (error) {
      if (error instanceof ProviderError) {
        // The person declining is a 400 — nothing is broken. A provider that
        // answers something the contract does not allow is a 502: the fault
        // is upstream, and saying "bad request" would blame the caller.
        throw error.kind === "denied"
          ? new BadRequestException(error.message)
          : new BadGatewayException(error.message);
      }
      throw error;
    }

    const result = await provisionOrganisation(db, {
      provider,
      providerAccountId: profile.id,
      displayName: profile.name ?? profile.login ?? null,
      email: profile.email ?? null,
      // No form to fill in (FR-TEN-01): the name comes from what the provider
      // granted, and nothing else is asked for.
      organisationName: `${profile.login ?? profile.name ?? "relay"}'s org`,
    });

    return {
      organisation: result.organisation,
      application: result.application,
      environment: result.environment,
      // Chapter 3.2, FR-AUT-02: the environment's first key, and the ONLY time
      // its secret exists outside a hash. It is present only when this call
      // created the tenant — a returning owner is not handed a new secret,
      // because the old one is unrecoverable by design and the recovery for a
      // lost key is rotation, not retrieval (research R8).
      ...(result.apiKey && {
        api_key: {
          prefix: result.apiKey.prefix,
          secret: result.apiKey.secret,
          shown_once: true,
        },
      }),
      created: result.created,
    };
  }
}
