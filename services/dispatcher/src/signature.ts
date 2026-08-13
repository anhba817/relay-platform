import { createHmac } from "node:crypto";

// The signature a customer verifies (chapter 3.5, FR-WHK-08).
//
// This is the platform's first contract addressed to code it did not write and
// cannot read. A REST consumer can retry against a sandbox and read an error
// message; a webhook consumer finds out at 3 a.m. that their check has been
// wrong for a week. So the construction below is deliberately dull: no length
// prefixes, no canonical JSON, no nested encoding. Everything a recipient needs
// is the request and the shared secret, and the recipe fits in five lines of
// their language.
//
// Kept in its own file, and behind a function, for SAD risk R7's reason: "isolate
// HMAC/crypto behind an interface" so a profiling-driven swap stays contained.

/** Travels with the value, not the header name, so a second algorithm is an
 * additional signature rather than a breaking change to the header set. */
export const SIGNATURE_SCHEME = "v1";

export const TIMESTAMP_HEADER = "relay-webhook-timestamp";
export const SIGNATURE_HEADER = "relay-webhook-signature";

/** `<scheme>:<timestamp>:<raw body>`.
 *
 * The timestamp is INSIDE the signed string rather than merely alongside it —
 * otherwise it is decoration, and a captured request replays forever. The body
 * is the raw bytes as they will be transmitted: signing a parsed-and-
 * re-serialised body is the single most common way a first integration fails,
 * and it fails in the direction that looks like the platform's bug. */
function canonicalString(timestamp: string, rawBody: string): string {
  return `${SIGNATURE_SCHEME}:${timestamp}:${rawBody}`;
}

export function signDelivery({
  rawBody,
  timestamp,
  secret,
}: {
  rawBody: string;
  timestamp: string;
  secret: string;
}): string {
  return createHmac("sha256", secret)
    .update(canonicalString(timestamp, rawBody))
    .digest("hex");
}

/** One signature per valid secret. During a rotation window an endpoint has two,
 * and a recipient holding either must be able to verify — that is what makes a
 * 24-hour window survivable without a synchronised deploy on the customer's
 * side (contracts/webhooks.md §Rotation). */
export function signatureHeaders({
  rawBody,
  timestamp,
  secrets,
}: {
  rawBody: string;
  timestamp: string;
  secrets: string[];
}): Record<string, string> {
  const signatures = secrets.map(
    (secret) =>
      `${SIGNATURE_SCHEME}=${signDelivery({ rawBody, timestamp, secret })}`,
  );
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signatures.join(","),
  };
}
