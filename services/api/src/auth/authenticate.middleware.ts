import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";

import type { Db } from "../db/client";
import {
  authenticateApiKey,
  environmentSigningSecret,
} from "../db/repository";
import { looksLikeApiKey } from "./api-key";
import { AuthLimiter } from "../limits/auth-limiter";
import { clientAddress } from "../limits/client-address";
import {
  bearerCredential,
  OVER_AUTH_THRESHOLD,
  type Principal,
  type RequestWithPrincipal,
} from "./principal";
import { environmentClaim, verifyUserToken } from "./user-token";

export const AUTH_DB = "AUTH_DB";

/** Credential in, principal out. The one function that decides who a caller is;
 * everything else in the api reads its answer.
 *
 * The two classes are told apart by the PREFIX, before either is verified —
 * that is what FR-AUT-03's visible `rk_` buys beyond human readability.
 *
 * A token's environment claim is read UNVERIFIED, because the api has to know
 * which environment's secret to check the signature with. The claim chooses the
 * key; the signature decides whether to believe the claim. Getting that order
 * backwards is how a token from environment A gets accepted for environment B.
 */
/** The internal platform credentials (chapter 3.5, extended by 3.11).
 * Configuration, never a database row and never tenant data — they authenticate
 * a SERVICE, and services are deployed, not provisioned.
 *
 * Absent by default, which is the safe direction: with nothing configured, no
 * request can ever present a platform principal, and the internal routes that
 * require one simply refuse everybody. Each service is absent independently.
 *
 * ONE SECRET PER SERVICE, AND CHAPTER 3.11 IS WHY. Until this chapter there was
 * one caller and this function ended `service: "dispatcher"`, hardcoded — which
 * was accurate exactly as long as the dispatcher was alone. The gateway now
 * reports connection-minutes, and `PlatformPrincipal.service` is documented as
 * "which internal service presented it, for logs": with one shared secret, the
 * one field in the principal that says who is asking becomes the one field that
 * cannot be trusted.
 *
 * The second property is worth more than the log line. The gateway terminates
 * connections from the public internet and the dispatcher does not, so a shared
 * secret lets the more exposed service set the blast radius for both.
 *
 * THE ALTERNATIVE, REFUSED: keep one secret and have the caller name itself in a
 * header, trusted only for logging. Chapter 3.2 spent itself removing exactly
 * that — the gateway used to send an environment header and a user header it had
 * invented — and "it is only for logs" is the sentence under which an asserted
 * header survives a review. */
export const PLATFORM_CREDENTIAL_ENV = "RELAY_INTERNAL_CREDENTIAL";
export const GATEWAY_CREDENTIAL_ENV = "RELAY_INTERNAL_CREDENTIAL_GATEWAY";
const PLATFORM_PREFIX = "rk_svc_";

/** Which variable belongs to which service. The dispatcher's keeps its original
 * name: renaming it would be a deployment change this chapter has not earned. */
const PLATFORM_SERVICES: ReadonlyArray<readonly [string, string]> = [
  [PLATFORM_CREDENTIAL_ENV, "dispatcher"],
  [GATEWAY_CREDENTIAL_ENV, "gateway"],
];

/** Constant-time-ish: compare lengths first, then every byte. A platform
 * credential is a shared secret, and an early-exit compare on a shared secret is
 * the one place a timing signal is worth the two lines to remove. */
function secretMatches(presented: string, configured: string): boolean {
  if (presented.length !== configured.length) return false;
  let mismatch = 0;
  for (let i = 0; i < presented.length; i++) {
    mismatch |= presented.charCodeAt(i) ^ configured.charCodeAt(i);
  }
  return mismatch === 0;
}

function resolvePlatformCredential(credential: string): Principal | null {
  // READ AT CALL TIME, NOT AT MODULE LOAD. `credentials.itest.ts` SETS these
  // variables during the test and says so in a comment; hoisting the read into a
  // module-level constant would break that quietly, and the suite would go green
  // against a credential nobody configured.
  for (const [variable, service] of PLATFORM_SERVICES) {
    const configured = process.env[variable];
    if (!configured || configured.length < 32) continue;
    if (secretMatches(credential, configured)) return { kind: "platform", service };
  }
  return null;
}

export async function resolvePrincipal(
  db: Db,
  credential: string,
): Promise<Principal | null> {
  // Checked before the key path, and recognised by prefix so a mistyped API key
  // never accidentally lands here. Note there is no database lookup: a platform
  // credential belongs to a deployment, not to a tenant, so resolving it must
  // not depend on a table any tenant appears in.
  if (credential.startsWith(PLATFORM_PREFIX)) {
    return resolvePlatformCredential(credential);
  }

  if (looksLikeApiKey(credential)) {
    const key = await authenticateApiKey(db, credential);
    return key
      ? {
          kind: "application",
          environmentId: key.environmentId,
          keyId: key.keyId,
        }
      : null;
  }

  const environmentId = environmentClaim(credential);
  if (!environmentId) return null;
  const environment = await environmentSigningSecret(db, environmentId);
  if (!environment) return null;
  const claims = await verifyUserToken(
    credential,
    environment.signingSecret,
    environmentId,
  );
  return claims
    ? { kind: "user", environmentId, userExternalId: claims.sub }
    : null;
}

/** Authentication runs in MIDDLEWARE, and that is a measured decision rather
 * than a preference (research R5, verified in T004). Chapter 2.6 found that
 * Nest constructs request-scoped providers BEFORE the enhancer chain, so a
 * guard cannot be the thing that resolves tenant scope — whatever it stashes on
 * the request is invisible to the factory that needs it. The observed order on
 * this code path is:
 *
 *     middleware  ->  request-scoped factory  ->  guard
 *
 * which is exactly enough room: the middleware resolves the principal, the
 * factory reads `req.principal.environmentId`, and the guard is left with the
 * narrower job it is actually good at — deciding whether this route accepts
 * this class of credential.
 *
 * It NEVER throws. A request that presents nothing simply has no principal, and
 * pre-credential routes (signup, health) are reached that way on purpose. A
 * request that presents something invalid also has no principal, so "absent"
 * and "does not verify" arrive at the same 401 — which is all a caller should
 * be able to learn.
 */
@Injectable()
export class AuthenticateMiddleware implements NestMiddleware {
  constructor(
    @Inject(AUTH_DB) private readonly db: Db,
    private readonly authLimiter: AuthLimiter,
  ) {}

  async use(
    req: RequestWithPrincipal & { socket?: { remoteAddress?: string } },
    _res: unknown,
    next: () => void,
  ): Promise<void> {
    const credential = bearerCredential(req.headers);
    if (credential !== null) {
      // Chapter 3.8 (FR-AUT-12). The failure is observable HERE — credential
      // present, principal null — so this is where it is counted. It is not where
      // it is refused: this middleware never throws, and `CredentialGuard` raises
      // the 429 from the flag below (research R18).
      const address = clientAddress(req);
      if (await this.authLimiter.isOverThreshold(address)) {
        req[OVER_AUTH_THRESHOLD] = true;
      }
      const principal = await resolvePrincipal(this.db, credential);
      if (principal !== null) {
        req.principal = principal;
      } else {
        await this.authLimiter.recordFailure(address);
      }
    }
    next();
  }
}
