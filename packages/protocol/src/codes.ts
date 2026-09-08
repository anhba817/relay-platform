// Close codes and protocol error codes — the contract's failure vocabulary.
// EIR-WS-06 requires close codes to distinguish authentication failure,
// quota exhaustion, server shutdown, and protocol violation. Two numbers are
// document-fixed (4001: EIR-WS-05; 4009: SAD §7); the other two classes are
// numbered here — chapter 1.3's recorded decision.

export const CLOSE_CODES = {
  4001: "invalid or expired token",
  4002: "protocol violation",
  4008: "quota exhausted",
  4009: "server shutdown (drain)",
} as const;

export type CloseCode = keyof typeof CLOSE_CODES;

// Protocol-level error codes carried by the `error` frame (EIR-API-04's
// shape). A starter registry — endpoints and services add their own codes in
// their chapters; uniqueness is test-enforced from day one.
export const ERROR_CODES = {
  invalid_frame: "the frame failed schema validation",
  unknown_frame_type: "the type discriminator names no known frame",
  unauthorized: "the connection is not authorized for this action",
  rate_limited: "too many frames; slow down and retry",
  // The SRS singles this out as the most common first-integration
  // failure, so it gets its own code instead of a generic `unauthorized`: the
  // response has to say which class was presented and which the route wanted.
  // The MESSAGE names the class and never the credential — "the key rk_dev_abc…
  // is invalid" is how a live secret reaches a support ticket (NFR-SEC-06).
  wrong_credential_type:
    "the credential class presented cannot use this route; the message names presented and expected",

  // ── THE FOUR THE FILTER SENDS AND THIS OBJECT NEVER DECLARED (FR-024) ────────
  //
  // `ProtocolErrorFilter` maps a status to a code when the thrower names none, and
  // four of the five it can produce are absent here. They have gone out on the wire
  // since chapter 2.2 widened that ladder, while this registry called itself the
  // documented vocabulary — and `docs_url` is DERIVED from the code, so every one of
  // them shipped a link to a page that cannot exist even in principle.
  //
  // Registering them is what makes the ladder typable. Annotated `ErrorCode`, a code
  // that is not here stops compiling instead of reaching a customer as a dead link.
  invalid_request:
    "the request body, query or path failed validation; `field` names the first offending key",
  forbidden: "the credential is valid and is not permitted to do this",
  not_found:
    "no such resource for this tenant — and DELIBERATELY the same answer as for a resource in another tenant (FR-TEN-05)",
  internal_error:
    "the platform failed in a way it did not anticipate; the request_id is what a support ticket needs",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Where the published error reference lives, and THE ONE PLACE THE URL IS BUILT
 * (FR-027, constitution V).
 *
 * THE DEBT THIS CLOSES. `docs_url` has been in the error envelope since chapter 1.3
 * and constitution V calls it a reachable-page promise. Three sites build it with a
 * template literal against a host that does not resolve, and a fourth would have
 * been added by every chapter that adds a code.
 *
 * THE CODE IS THE ANCHOR, VERBATIM. No slug transform, no case change, no separator
 * swap — the reference's headings ARE the codes. A transform here is a second
 * vocabulary to keep in step with the first, and the registry already IS the
 * vocabulary.
 *
 * The host stays a placeholder until the docs site exists. What stops being a
 * placeholder is the NUMBER OF PLACES that have to change when it does: one. */
export const ERROR_DOCS_BASE = "https://relay.example/docs/errors";

export function docsUrl(code: ErrorCode): string {
  return `${ERROR_DOCS_BASE}/${code}`;
}
