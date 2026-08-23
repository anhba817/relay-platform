import { HttpException } from "@nestjs/common";
import type { ErrorCode } from "@relay/protocol";

/** An HTTP failure that NAMES ITS OWN CODE, typed (chapter 3.12, FR-025, FR-026).
 *
 * Chapter 3.2 introduced the convention that a thrower may name its code, because
 * `wrong_credential_type` is a distinction a status cannot carry. What it could not
 * introduce was any check on the string: `HttpException`'s response is `unknown`,
 * so `code: "wrong_credental_type"` compiles, ships, and becomes a `docs_url`
 * pointing at a page that does not exist. Eight sites named their code by hand.
 *
 * This is one function so `ErrorCode` is the only thing that fits. The value is
 * exactly what `ProtocolErrorFilter` already reads — `code`, `message` and the
 * optional `field` — so nothing about the envelope changes; what changes is that a
 * typo stops compiling. */
export function protocolError(
  code: ErrorCode,
  message: string,
  status: number,
  field?: string,
): HttpException {
  return new HttpException(
    { code, message, ...(field !== undefined ? { field } : {}) },
    status,
  );
}
