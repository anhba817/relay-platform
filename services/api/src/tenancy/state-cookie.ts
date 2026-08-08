import { randomBytes, timingSafeEqual } from "node:crypto";

// The CSRF binding for the OAuth flow (chapter 3.1).
//
// `state` exists to prove that the callback belongs to the browser that
// started the flow. A signed-but-stateless state proves the SERVER minted it
// and nothing more — an attacker can start a flow, take the state, and feed
// the victim a callback URL that still verifies. Binding needs something only
// that browser holds, which is a cookie. Five lines of header parsing, and no
// dependency for it.

export const STATE_COOKIE = "relay_oauth_state";
const MAX_AGE_SECONDS = 600;

export function mintState(): string {
  return randomBytes(16).toString("hex");
}

/** `Path=/auth` keeps it off every other request; `SameSite=Lax` still allows
 * the provider's top-level redirect back; `HttpOnly` keeps script away from
 * it. `Secure` is omitted only when the base URL is plain http, which is the
 * local case — a reader on localhost would otherwise never receive it. */
export function stateCookie(value: string, secure: boolean): string {
  const parts = [
    `${STATE_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/auth",
    `Max-Age=${value === "" ? 0 : MAX_AGE_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearStateCookie(secure: boolean): string {
  return stateCookie("", secure);
}

/** Read one cookie out of a raw header. No parser dependency: the format is
 * `a=1; b=2`, and anything that does not match that is not a cookie we set. */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/** Constant-time comparison. The state is not a secret in the way a password
 * is, but it is compared on every callback and the cost of doing it properly
 * is one function call. */
export function statesMatch(
  fromQuery: string | undefined,
  fromCookie: string | undefined,
): boolean {
  if (!fromQuery || !fromCookie) return false;
  const a = Buffer.from(fromQuery);
  const b = Buffer.from(fromCookie);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
