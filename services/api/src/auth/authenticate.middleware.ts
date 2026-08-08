import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";

import type { Db } from "../db/client";
import {
  authenticateApiKey,
  environmentSigningSecret,
} from "../db/repository";
import { looksLikeApiKey } from "./api-key";
import { bearerCredential, type Principal, type RequestWithPrincipal } from "./principal";
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
export async function resolvePrincipal(
  db: Db,
  credential: string,
): Promise<Principal | null> {
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
  constructor(@Inject(AUTH_DB) private readonly db: Db) {}

  async use(
    req: RequestWithPrincipal,
    _res: unknown,
    next: () => void,
  ): Promise<void> {
    const credential = bearerCredential(req.headers);
    if (credential !== null) {
      const principal = await resolvePrincipal(this.db, credential);
      if (principal !== null) req.principal = principal;
    }
    next();
  }
}
