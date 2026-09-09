import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SIGNATURE_SCHEME, signDelivery, signatureHeaders } from "./signature.js";

/** Hardcoded, NOT imported. A customer reads "v1" out of the documentation and
 * types it into their own code; if the platform ever changes it, their
 * verification breaks — so this file must break too. Importing the constant
 * would let a breaking contract change slip through green. */
const SCHEME_FROM_THE_DOCS = "v1";

// Invariants 4 and 5 (contracts/dispatcher.md).
//
// THE RULE FOR THIS FILE: the verifying side below is written from
// `contracts/webhooks.md` §Verifying and from nothing else. It does not import
// the signing code, and it must not — a test that verifies with `signDelivery`
// proves only that the function agrees with itself, which is the single thing a
// customer cannot rely on. A customer has the documentation and a language of
// their choice; so does this file.

/** The recipe, transcribed:
 *   1. take the raw body bytes, before any JSON parsing
 *   2. canonical string = "<scheme>:<timestamp>:<raw body>"
 *   3. HMAC-SHA256 with the shared secret, hex
 *   4. compare in constant time (a test may compare directly) */
function verifyFromTheDocumentation(
  rawBody: string,
  timestamp: string,
  secret: string,
  candidate: string,
): boolean {
  const canonical = `${SCHEME_FROM_THE_DOCS}:${timestamp}:${rawBody}`;
  const expected = createHmac("sha256", secret).update(canonical).digest("hex");
  return expected === candidate;
}

const SECRET = "whsec_test_2f4b8c1e9a7d3f6b5c0e8a2d4f6b8c1e";
const BODY = JSON.stringify({
  id: "8f14e45f-ceea-4f6a-9b2c-1d2e3f4a5b6c",
  type: "message.created",
  environment_id: "3f2a0000-0000-0000-0000-000000000001",
  occurred_at: "2026-08-10T09:15:00.000Z",
  data: { id: "57d5cdf0", channel_id: "ce419dc5", seq: 1, user: "tuan", text: "B2, north ramp", created_at: "2026-08-10T09:15:00.000Z" },
});

describe("invariant 4: a recipient can verify with only the request and the secret", () => {
  it("verifies against a verifier written from the documentation, not from the signer", () => {
    const timestamp = "1786500000";

    const signature = signDelivery({ rawBody: BODY, timestamp, secret: SECRET });

    expect(verifyFromTheDocumentation(BODY, timestamp, SECRET, signature)).toBe(
      true,
    );
  });

  it("fails against the wrong secret", () => {
    const timestamp = "1786500000";
    const signature = signDelivery({ rawBody: BODY, timestamp, secret: SECRET });

    expect(
      verifyFromTheDocumentation(BODY, timestamp, "whsec_not_the_one", signature),
    ).toBe(false);
  });

  it("binds the timestamp, so a captured request cannot be replayed indefinitely", () => {
    const signature = signDelivery({
      rawBody: BODY,
      timestamp: "1786500000",
      secret: SECRET,
    });

    // Same body, same secret, different timestamp — the signature must not carry
    // over, or the timestamp is decoration rather than a replay bound.
    expect(
      verifyFromTheDocumentation(BODY, "1786599999", SECRET, signature),
    ).toBe(false);
  });

  it("publishes the scheme the documentation names", () => {
    // The one place the constant and the docs are checked against each other.
    // Everything else in this file uses the documented literal.
    expect(SIGNATURE_SCHEME).toBe(SCHEME_FROM_THE_DOCS);
  });

  it("emits headers a recipient can find the parts in", () => {
    const headers = signatureHeaders({
      rawBody: BODY,
      timestamp: "1786500000",
      secrets: [SECRET],
    });

    const timestamp = headers["relay-webhook-timestamp"] ?? "";
    const signature = headers["relay-webhook-signature"] ?? "";
    expect(timestamp).toBe("1786500000");
    // The scheme travels with the value, so a future algorithm is additive
    // rather than a breaking change to the header set.
    expect(signature).toMatch(new RegExp(`^${SCHEME_FROM_THE_DOCS}=[0-9a-f]{64}$`));

    const hex = signature.split("=")[1] ?? "";
    expect(verifyFromTheDocumentation(BODY, timestamp, SECRET, hex)).toBe(true);
  });

  it("carries one signature per valid secret during a rotation window", () => {
    const OLD = "whsec_the_previous_one";
    const headers = signatureHeaders({
      rawBody: BODY,
      timestamp: "1786500000",
      secrets: [SECRET, OLD],
    });

    // A recipient that still holds the old secret must be able to verify, and
    // one that has taken the new one must too. That is what makes a 24-hour
    // window survivable without a synchronised deploy.
    const parts: string[] = (headers["relay-webhook-signature"] ?? "").split(",");
    expect(parts).toHaveLength(2);

    const hexes: string[] = parts.map((p: string) => p.split("=")[1] ?? "");
    expect(
      hexes.some((h: string) =>
        verifyFromTheDocumentation(BODY, "1786500000", SECRET, h),
      ),
    ).toBe(true);
    expect(
      hexes.some((h: string) =>
        verifyFromTheDocumentation(BODY, "1786500000", OLD, h),
      ),
    ).toBe(true);
  });
});

describe("invariant 5: the trap, asserted rather than warned about", () => {
  it("does not verify when the body is parsed and re-serialised first", () => {
    const timestamp = "1786500000";
    const signature = signDelivery({ rawBody: BODY, timestamp, secret: SECRET });

    // The mistake almost every first integration makes. Round-tripping through
    // JSON is semantically identity-preserving and byte-wise is not: key order
    // and whitespace move, so the HMAC input changes while the payload looks
    // identical in a log.
    const reserialised = JSON.stringify(JSON.parse(BODY), ["type", "id"]);
    expect(reserialised).not.toBe(BODY);

    expect(
      verifyFromTheDocumentation(reserialised, timestamp, SECRET, signature),
    ).toBe(false);
  });

  it("is sensitive to whitespace alone", () => {
    const timestamp = "1786500000";
    const signature = signDelivery({ rawBody: BODY, timestamp, secret: SECRET });

    // Even a pretty-printer defeats it. This is the version that bites people
    // whose framework helpfully formats bodies before handing them over.
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);

    expect(verifyFromTheDocumentation(pretty, timestamp, SECRET, signature)).toBe(
      false,
    );
  });
});
