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
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
