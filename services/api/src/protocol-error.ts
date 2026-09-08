import { HttpException } from "@nestjs/common";

import type { ErrorCode } from "@relay/protocol";

/** An HTTP failure that NAMES ITS OWN CODE, typed (FR-025, FR-026).
 *
 * The credentials chapter introduced the convention that a thrower may name its
 * code, because `wrong_credential_type` is a distinction a status cannot carry: a
 * 403 that calls itself "forbidden" tells an integrator they lack a permission,
 * when what they did was present the wrong kind of credential.
 *
 * WHAT IT COULD NOT INTRODUCE WAS ANY CHECK ON THE STRING. `HttpException`'s
 * response is `unknown`, so `code: "wrong_credental_type"` compiles, ships, and
 * becomes a `docs_url` pointing at a page that does not exist. Nothing in the
 * toolchain reads that string; the first reader is a customer.
 *
 * This is one function so `ErrorCode` is the only thing that fits. The value is
 * exactly what `ProtocolErrorFilter` already reads — `code`, `message` and the
 * optional `field` — so nothing about the envelope changes. What changes is that a
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
