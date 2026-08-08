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
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
