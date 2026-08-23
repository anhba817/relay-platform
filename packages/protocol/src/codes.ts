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
  // Chapter 3.2. The SRS singles this out as the most common first-integration
  // failure, so it gets its own code instead of a generic `unauthorized`: the
  // response has to say which class was presented and which the route wanted.
  // The MESSAGE names the class and never the credential — "the key rk_dev_abc…
  // is invalid" is how a live secret reaches a support ticket (NFR-SEC-06).
  wrong_credential_type:
    "the credential class presented cannot use this route; the message names presented and expected",
  // Chapter 3.11. The socket's half of a quota refusal: an error frame carrying
  // the dimension, the figures and the resume date, sent immediately before
  // close code 4008.
  //
  // REGISTERED HERE RATHER THAN WRITTEN INLINE. The frame schema types `code` as
  // `z.string().min(1)`, so nothing forces this — but the registry is the
  // documented vocabulary and `codes.test.ts` enforces its uniqueness, which is
  // why chapter 3.2 put `wrong_credential_type` in it instead of inventing it at
  // the call site.
  quota_exceeded:
    "a monthly quota is exhausted; the message names the dimension, the figures and the date it resumes",
  // Chapter 3.12. The refusal beside `wrong_credential_type`, one dimension over:
  // the class presented is RIGHT and the service is not. Two platform credentials
  // exist — the dispatcher's and the gateway's — and until this chapter a route
  // could say which class may call it and not which service, so the gateway's
  // credential reached `POST /internal/dispatch/replay`.
  //
  // NOT `forbidden`. Chapter 3.2 made this argument when it added
  // `wrong_credential_type` rather than answering a wrong-credential mistake with
  // a generic 403: the response has to say what actually happened, and "you lack a
  // permission" is a different fact from "that credential belongs to another
  // service". The MESSAGE names the service and the permitted set and never the
  // credential — a service name is a deployment label, a credential is a secret
  // (NFR-SEC-06).
  wrong_credential_service:
    "the credential's service is not permitted on this route; the message names the service presented and the services allowed",
  // Chapter 3.12. FR-CHN-07's ceiling: a channel holds at most 1,000 members and
  // an add that would cross it is refused with 422 and this code.
  //
  // The SRS names this code in its own worked example for EIR-API-04, which is
  // the reason it is spelled this way rather than `member_limit_exceeded` — the
  // document got there first and an integrating developer will have read it.
  //
  // NOT `quota_exceeded`. That one is a monthly, billable, resets-on-a-date
  // refusal and its message promises a resume date; this is a structural limit on
  // one channel that no amount of waiting changes. Same status code, different
  // fact, and a client that retries on the wrong one waits for ever.
  channel_member_limit_exceeded:
    "the channel already holds its maximum members; the message names the limit and the channel",

  // ── THE FIVE THE PLATFORM HAS ALWAYS SENT AND NEVER REGISTERED (chapter 3.12,
  // FR-024) ────────────────────────────────────────────────────────────────────
  //
  // `ProtocolErrorFilter` maps a status to a code when the thrower names none,
  // and those codes went out on the wire for twenty-two chapters without being in
  // this object. The registry called itself "the documented vocabulary" while
  // documenting eight of thirteen — and `docs_url` is derived from the code, so
  // every one of these five shipped a link to a page that could not exist.
  //
  // Registering them is what makes the filter's ladder typable: with it annotated
  // `ErrorCode`, a code that is not here stops compiling instead of reaching a
  // customer with a 404 for a docs link.
  invalid_request:
    "the request body, query or path failed validation; `field` names the first offending key",
  forbidden: "the credential is valid and is not permitted to do this",
  not_found:
    "no such resource for this tenant — and DELIBERATELY the same answer as for a resource in another tenant (FR-TEN-05)",
  internal_error:
    "the platform failed in a way it did not anticipate; the request_id is what a support ticket needs",
  // Chapter 3.11's. A connection belongs to one environment for its lifetime, and
  // a second report naming a different one is a bug in the reporter rather than a
  // state to reconcile — so it is refused rather than absorbed.
  connection_environment_conflict:
    "this connection was first reported for a different environment; a connection belongs to one environment for its whole life",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** The published reference, and the one place the URL is built (FR-027,
 * `contracts/errors.md` §2).
 *
 * THE DEBT THIS CLOSES. `docs_url` has been in the error envelope since chapter
 * 1.3 and constitution V calls it a reachable-page promise. Six construction sites
 * built it with a template literal against `https://relay.example`, a host that
 * does not resolve, and two codes — `rate_limited` (3.8) and `quota_exceeded`
 * (3.10, 3.11) — shipped links to pages that did not exist even in principle.
 * Chapter 3.11 declined to add a third instance and named the debt; a chapter whose
 * exit criterion is "integrates on public documentation alone" cannot ship a
 * fourth.
 *
 * THE CODE IS THE ANCHOR, VERBATIM. No slug transform, no case change, no
 * separator swap — the reference's `h2` headings ARE the codes, and
 * `slugifyHeading` in the tutorial site keeps `_` so `## quota_exceeded` anchors
 * at `#quota_exceeded`. Any transform here would be the same transform maintained
 * in two repositories with no test able to see both sides.
 *
 * The base is overridable so a preview deployment can point at itself. It is read
 * per call rather than captured at module load: a test that sets the variable in
 * `beforeAll` would otherwise get the value from whenever this module was first
 * imported. */
export const DEFAULT_DOCS_BASE_URL = "https://relay.dev/docs/error-reference";

export function docsUrl(code: ErrorCode): string {
  const base = process.env["RELAY_DOCS_BASE_URL"] ?? DEFAULT_DOCS_BASE_URL;
  return `${base}#${code}`;
}
