import { SignJWT, decodeJwt, jwtVerify } from "jose";

// End-user tokens (chapter 3.2, FR-AUT-06/07/08). HS256 over the
// environment's own signing secret, verified by `jose` rather than by hand.
//
// WHY a dependency here, when 3.1 went out of its way to add none: hand-rolled
// HS256 is thirty lines and three classic vulnerabilities — accepting whatever
// algorithm the token names, forgetting to check `exp`, and comparing
// signatures with `===`. A convenience is worth typing around; security code is
// not (research R4).

/** FR-AUT-07. Enforced at BOTH ends: this api will not mint a longer-lived
 * token, and will not accept one either — including one signed with a secret it
 * trusts, because a secret can leak and a bound that only applies at mint time
 * is a bound on well-behaved callers. */
export const MAX_TOKEN_LIFETIME_SECONDS = 86_400;

const ALGORITHMS = ["HS256"] as const;

export interface TokenClaims {
  sub: string;
  env: string;
  iat: number;
  exp: number;
}

export interface MintOptions {
  user: string;
  environmentId: string;
  ttlSeconds: number;
  /** Overridden only by tests that need a token issued in the past. */
  issuedAt?: number;
  /** Test-only escape hatch: mint a token this api would refuse, so the refusal
   * can be proven rather than assumed. Never set by product code. */
  allowOverLongLifetime?: boolean;
}

export async function mintUserToken(
  signingSecret: string,
  {
    user,
    environmentId,
    ttlSeconds,
    issuedAt,
    allowOverLongLifetime = false,
  }: MintOptions,
): Promise<{ token: string; expiresAt: string }> {
  if (!allowOverLongLifetime && ttlSeconds > MAX_TOKEN_LIFETIME_SECONDS) {
    throw new Error(
      `a token may not live longer than 24 hours (${MAX_TOKEN_LIFETIME_SECONDS}s)`,
    );
  }
  const iat = issuedAt ?? Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const token = await new SignJWT({ env: environmentId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(signingSecret));
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Reads the environment claim WITHOUT verifying anything, because the api has
 * to know which environment's secret to check the signature with before it can
 * check it. That is the only thing this function is for: the lookup is by
 * claim, the trust is by signature (data-model). */
export function environmentClaim(token: string): string | null {
  try {
    const claims = decodeJwt(token);
    return typeof claims.env === "string" && claims.env.length > 0
      ? claims.env
      : null;
  } catch {
    return null;
  }
}

/** Null for every failure, with no distinction between them: expired,
 * malformed, mis-signed and foreign are one answer to a caller (FR-AUT-08's
 * refusal), and telling them apart in a response body is how an attacker learns
 * which half of a guess was right. */
export async function verifyUserToken(
  token: string,
  signingSecret: string,
  environmentId: string,
): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(signingSecret),
      // The allow-list is the whole defence against algorithm confusion: `jose`
      // refuses `alg: none` and any algorithm not named here BEFORE it looks at
      // key material. Passing the token's own header back as the algorithm is
      // the vulnerability this line exists to make impossible.
      { algorithms: [...ALGORITHMS] },
    );
    const { sub, env, iat, exp } = payload;
    if (typeof sub !== "string" || sub.length === 0) return null;
    // Non-empty, and the environment we verified against. An empty env claim
    // would be a session scoped to no tenant, which constitution I says must be
    // unrepresentable rather than unlikely (2.5 found this the same way).
    if (typeof env !== "string" || env !== environmentId) return null;
    if (typeof iat !== "number" || typeof exp !== "number") return null;
    if (exp - iat > MAX_TOKEN_LIFETIME_SECONDS) return null;
    return { sub, env, iat, exp };
  } catch {
    // Includes the expiry check: `jose` throws on an expired token rather than
    // returning it, so `exp` is enforced by the library and not by a comparison
    // this file could forget to write.
    return null;
  }
}
