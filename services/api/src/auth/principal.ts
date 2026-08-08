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

export type Principal = ApplicationPrincipal | UserPrincipal;
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
  return kind === "application" ? "an API key" : "an end-user token";
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
