import { describe, expect, it } from "vitest";

import { hashSecret } from "../auth/api-key";
import {
  activeSigningSecrets,
  decryptSecret,
  encryptSecret,
  mintSigningSecret,
  ROTATION_WINDOW_MS,
} from "./secret";

// Why a webhook signing secret is NOT stored the way chapter 3.2 stored an API
// key — and the resemblance between the two is exactly the trap.
//
// NFR-SEC-02 covers both in one sentence: "API key secrets and webhook signing
// secrets shall be stored only as salted hashes OR under envelope encryption."
// Two credentials, one requirement, two mechanisms — and the reason is not that
// one is more sensitive than the other. It is that the VERBS differ:
//
//   an API key is VERIFIED — a caller presents it, we hash what arrived and
//   compare, and we never need the original again;
//
//   a signing secret is USED — we must compute an HMAC with it on every
//   delivery, which requires the secret itself.
//
// A hash cannot be used. It can only be compared. That is the whole argument,
// and the first test states it as a property rather than a comment.

describe("a signing secret must survive storage, not merely be recognisable", () => {
  it("comes back out of storage byte-for-byte", () => {
    const secret = mintSigningSecret();

    const recovered = decryptSecret(encryptSecret(secret));

    // The property FR-WHK-08 needs and a hash cannot provide. If this ever
    // fails, no delivery can be signed and every customer's verification breaks
    // at once.
    expect(recovered).toBe(secret);
  });

  it("cannot be recovered from chapter 3.2's treatment of the other credential", () => {
    const secret = mintSigningSecret();

    // Hashing is what 3.2 does to an API key, and it is one-way on purpose. The
    // digest is not the secret and no amount of care turns it back into one, so
    // an implementation that reached for `hashSecret` here would compile, pass a
    // careless review, and be unable to sign anything.
    const digest = hashSecret(secret, "some-salt");

    expect(digest).not.toBe(secret);
    expect(() => decryptSecret(digest)).toThrow();
  });
});

describe("encryption at rest, not obfuscation", () => {
  it("does not leave the secret readable in the stored value", () => {
    const secret = mintSigningSecret();

    const stored = encryptSecret(secret);

    // The point of the requirement, not of the algorithm: whatever lands in the
    // column must not contain the plaintext. A base64 round-trip would satisfy
    // "not equal" and fail this.
    expect(stored).not.toContain(secret);
    expect(Buffer.from(stored, "base64").toString("utf8")).not.toContain(secret);
  });

  it("produces a different ciphertext every time, so equal secrets are not detectable", () => {
    const secret = mintSigningSecret();

    // A deterministic ciphertext leaks equality: an operator reading the table
    // could tell which endpoints share a secret without decrypting anything.
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("refuses a tampered ciphertext rather than returning wrong bytes", () => {
    const stored = encryptSecret(mintSigningSecret());
    const tampered = stored.slice(0, -4) + (stored.endsWith("A") ? "BBBB" : "AAAA");

    // Authenticated encryption, so a modified value is an error rather than
    // plausible-looking garbage that would be signed with and silently break
    // every signature for that endpoint.
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe("minting", () => {
  it("produces a secret with enough entropy to be worth protecting", () => {
    const a = mintSigningSecret();
    const b = mintSigningSecret();

    expect(a).not.toBe(b);
    // 256 bits, the same budget 3.2 gave an API key secret.
    expect(Buffer.from(a, "base64url").length).toBeGreaterThanOrEqual(32);
  });
});

describe("the rotation window closes", () => {
  const build = (rotatedAt: Date | null, withPrevious = true) => {
    const current = mintSigningSecret();
    const previous = mintSigningSecret();
    return {
      current,
      previous,
      endpoint: {
        secretCiphertext: encryptSecret(current),
        secretPreviousCiphertext: withPrevious ? encryptSecret(previous) : null,
        secretRotatedAt: rotatedAt,
      },
    };
  };

  it("signs with both secrets inside the window", () => {
    const rotatedAt = new Date("2026-08-10T00:00:00.000Z");
    const { current, previous, endpoint } = build(rotatedAt);

    const active = activeSigningSecrets(
      endpoint,
      new Date(rotatedAt.getTime() + ROTATION_WINDOW_MS - 1000),
    );

    expect(active).toEqual([current, previous]);
  });

  it("drops the previous secret once the window has passed", () => {
    const rotatedAt = new Date("2026-08-10T00:00:00.000Z");
    const { current, endpoint } = build(rotatedAt);

    const active = activeSigningSecrets(
      endpoint,
      new Date(rotatedAt.getTime() + ROTATION_WINDOW_MS),
    );

    // The half that matters. A previous secret that never expires is not a
    // rotation — it is a second permanent credential, and a customer who
    // rotated because of a leak would still be accepting the leaked one.
    expect(active).toEqual([current]);
  });

  it("signs with one secret when nothing has been rotated", () => {
    const { current, endpoint } = build(null, false);
    expect(activeSigningSecrets(endpoint)).toEqual([current]);
  });
});
