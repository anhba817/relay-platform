import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

// Webhook signing secrets at rest (chapter 3.5).
//
// DECISION (chapter 3.5): envelope encryption, not the salted hash chapter 3.2
// used for API keys. NFR-SEC-02 permits either — "salted hashes or under
// envelope encryption" — and this is the branch that applies, for a reason worth
// stating because the two credentials look so alike:
//
//   an API key is VERIFIED. A caller presents it, we hash what arrived and
//   compare digests. The original is never needed again, so keeping it would be
//   a liability with no upside.
//
//   a signing secret is USED. Every delivery computes an HMAC with it. A hash
//   cannot be used, only compared — so hashing it here would not be "more
//   secure", it would make the feature impossible.
//
// The cost is real and is not hidden: this is the first customer credential the
// platform can turn back into plaintext. That raises obligations a hash did not.
// The key lives in configuration and never in the database (a key stored beside
// the ciphertext it protects is a filing convention, not encryption), the
// plaintext exists only in memory and only for the duration of a signature, and
// it appears in no log line at any level (NFR-SEC-06).

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;
const SECRET_BYTES = 32; // 256 bits, the budget 3.2 gave an API key secret

/** The stored value is `iv | tag | ciphertext`, base64. One column, no schema
 * for the reader to decode, and no second place for the IV to drift out of sync
 * with the payload it belongs to. */
const IV_END = IV_BYTES;
const TAG_END = IV_BYTES + TAG_BYTES;

export const WEBHOOK_SECRET_KEY_ENV = "RELAY_WEBHOOK_SECRET_KEY";

/** Resolved per call rather than at import time: a module that throws on import
 * takes the whole service down at startup over a feature most requests never
 * touch, and it makes the failure unreachable in a unit test. */
function encryptionKey(): Buffer {
  const configured = process.env[WEBHOOK_SECRET_KEY_ENV];
  if (!configured) {
    // Development only, and deliberately loud about it. A silent default here
    // would mean production quietly encrypting with a key from a tutorial.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `${WEBHOOK_SECRET_KEY_ENV} is required in production: webhook signing secrets cannot be stored without it`,
      );
    }
    return Buffer.alloc(KEY_BYTES, "relay-development-key-not-for-production");
  }
  const key = Buffer.from(configured, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${WEBHOOK_SECRET_KEY_ENV} must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

/** A new signing secret, shown to the customer once and never again. */
export function mintSigningSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function encryptSecret(secret: string): string {
  // A fresh IV per call, which is what makes two encryptions of the same secret
  // differ. A deterministic ciphertext would leak equality: an operator reading
  // the table could see which endpoints share a secret without decrypting one.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptSecret(stored: string): string {
  const raw = Buffer.from(stored, "base64");
  if (raw.length <= TAG_END) {
    throw new Error("webhook secret ciphertext is too short to be valid");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    raw.subarray(0, IV_END),
  );
  // GCM's tag is why a tampered value THROWS rather than returning plausible
  // garbage. Signing with silently-wrong bytes would break every signature for
  // that endpoint while looking like it worked.
  decipher.setAuthTag(raw.subarray(IV_END, TAG_END));
  return Buffer.concat([
    decipher.update(raw.subarray(TAG_END)),
    decipher.final(),
  ]).toString("utf8");
}

/** The rotation window: 24 hours (contracts/webhooks.md §Rotation).
 *
 * Long enough that a customer can roll a configuration change across their fleet
 * without a deploy window becoming an outage; short enough that a secret they
 * rotated *because it leaked* stops working the same day. Fixed here because it
 * is a promise a recipient writes code against, not a tuning parameter. */
export const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Which secrets a delivery must be signed with right now.
 *
 * Two during the window, one after it — and the "after it" half is the part that
 * matters. A previous secret that never expires is not a rotation, it is a
 * second permanent credential, and a customer who rotated because of a leak
 * would still be accepting the leaked one. */
export function activeSigningSecrets(
  endpoint: {
    secretCiphertext: string;
    secretPreviousCiphertext: string | null;
    secretRotatedAt: Date | null;
  },
  now: Date = new Date(),
): string[] {
  const current = decryptSecret(endpoint.secretCiphertext);
  if (!endpoint.secretPreviousCiphertext || !endpoint.secretRotatedAt) {
    return [current];
  }
  const elapsed = now.getTime() - endpoint.secretRotatedAt.getTime();
  if (elapsed >= ROTATION_WINDOW_MS) return [current];
  return [current, decryptSecret(endpoint.secretPreviousCiphertext)];
}
