// What authentication produces (chapter 3.2). Never persisted, never sent —
// this is the shape the rest of a request reasons about instead of reading a
// header somebody asserted.
//
// Two classes, because the platform has two populations to authenticate: the
// APPLICATION integrating with Relay, and the END USER inside one of its
// environments. ADR-18 drew that line through the data; this draws it through
// the request.

export interface ApplicationPrincipal {
  kind: "application";
  /** Resolved from the key, never from the caller's word for it. */
  environmentId: string;
  /** For last_used_at, and for 3.6's quota accounting. */
  keyId: string;
}

export interface UserPrincipal {
  kind: "user";
  environmentId: string;
  userExternalId: string;
}

/** The platform acting for itself (chapter 3.5).
 *
 * The dispatcher is the first caller of the internal seam that is neither a
 * tenant's software nor an end user: it consumes every environment's events and
 * asks the api to write on behalf of all of them.
 *
 * THE SHORTCUT THAT WOULD HAVE WORKED AND BEEN WRONG: mint the dispatcher an API
 * key. It would authenticate on the first try — and an `application` principal
 * is scoped to exactly ONE environment by construction (3.1, 3.2), so a
 * dispatcher holding one either cannot serve other tenants or has been quietly
 * granted cross-tenant reach through the credential type whose entire meaning is
 * that it has none. Principle I is a correctness property, and that is the shape
 * its erosion would take.
 *
 * So this kind carries NO `environmentId`. That is not an omission — it is what
 * stops it being usable anywhere a tenant is expected: every environment-scoped
 * provider reads `environmentId`, and a principal without one cannot silently
 * become a tenant's. It is accepted only where a route opts in, and never on a
 * public route. */
export interface PlatformPrincipal {
  kind: "platform";
  /** Which internal service presented it, for logs. Never the credential. */
  service: string;
  /** Present and always undefined, so the environment-scoped providers that read
   * `principal?.environmentId` keep compiling AND keep getting nothing. A
   * platform principal reaching a tenant-scoped repository yields the empty
   * scope, which the guard has already refused before any handler runs. */
  environmentId?: undefined;
}

export type Principal =
  | ApplicationPrincipal
  | UserPrincipal
  | PlatformPrincipal;
export type PrincipalKind = Principal["kind"];

/** The request as everything downstream of the middleware sees it. The
 * principal is optional at the type level for one honest reason: a request that
 * presented nothing has none, and pre-credential routes (signup) are reached
 * exactly that way. */
export interface RequestWithPrincipal {
  headers: Record<string, string | string[] | undefined>;
  principal?: Principal;
}

/** How a credential class is named to a human. Used by the wrong-credential
 * error, which must say what was presented and what was expected — and must
 * never quote the credential (NFR-SEC-06). */
export function describePrincipalKind(kind: PrincipalKind): string {
  if (kind === "application") return "an API key";
  if (kind === "platform") return "an internal platform credential";
  return "an end-user token";
}

/** The `Bearer <credential>` half of RFC 6750, and nothing else. Query strings
 * are refused by omission: URLs reach logs and referrer headers, and NFR-SEC-06
 * forbids a credential in either. (The WebSocket upgrade is the one exception,
 * and it lives in the gateway where a browser gives no other choice.) */
export function bearerCredential(
  headers: RequestWithPrincipal["headers"],
): string | null {
  const raw = headers["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const match = /^Bearer (.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}
