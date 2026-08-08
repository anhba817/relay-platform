import { describe, expect, it } from "vitest";

import {
  KEY_PREFIXES,
  hashSecret,
  looksLikeApiKey,
  mintApiKey,
  parseApiKeyCredential,
  prefixMatchesKind,
  secretMatches,
} from "./api-key";

// The credential's own rules (chapter 3.2), Docker-free: format, prefix,
// hashing, comparison. Everything here is pure — the database appears in
// credentials.itest.ts, not in this file.

describe("mintApiKey", () => {
  it("gives a development key the rk_dev_ prefix and production rk_live_", () => {
    // Invariant 12 (FR-AUT-03): the prefix mirrors the environment kind, so a
    // human can see which environment they are about to point at.
    expect(mintApiKey("development").prefix).toBe("rk_dev_");
    expect(mintApiKey("production").prefix).toBe("rk_live_");
    expect(mintApiKey("development").credential.startsWith("rk_dev_")).toBe(
      true,
    );
    expect(mintApiKey("production").credential.startsWith("rk_live_")).toBe(
      true,
    );
  });

  it("returns a credential that parses back to its own public id", () => {
    const minted = mintApiKey("development");
    const parsed = parseApiKeyCredential(minted.credential);
    expect(parsed).not.toBeNull();
    expect(parsed!.publicId).toBe(minted.publicId);
    expect(parsed!.prefix).toBe(minted.prefix);
    expect(secretMatches(parsed!.secret, minted.salt, minted.secretHash)).toBe(
      true,
    );
  });

  it("never repeats a public id or a secret", () => {
    const many = Array.from({ length: 50 }, () => mintApiKey("development"));
    expect(new Set(many.map((k) => k.publicId)).size).toBe(50);
    expect(new Set(many.map((k) => k.credential)).size).toBe(50);
  });

  it("does not carry the secret inside the stored fields", () => {
    // What is kept at rest must not contain what was shown once (FR-AUT-02,
    // NFR-SEC-02). The hash is the only trace, and a hash that embedded its
    // input would make the salt pointless.
    const minted = mintApiKey("development");
    const secret = parseApiKeyCredential(minted.credential)!.secret;
    expect(minted.secretHash).not.toContain(secret);
    expect(minted.salt).not.toContain(secret);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });
});

describe("parseApiKeyCredential", () => {
  it("refuses anything that is not a key, without throwing", () => {
    // Returning null rather than throwing is deliberate: a thrown error would
    // carry the presented string into a stack trace, and NFR-SEC-06 forbids a
    // credential appearing in a log line.
    for (const bad of [
      "",
      "rk_dev_",
      "rk_dev_abc",
      "rk_test_0123456789abcdef0123456789abcdef_secret",
      "0123456789abcdef0123456789abcdef_secret",
      "Bearer rk_dev_0123456789abcdef0123456789abcdef_secret",
      "rk_dev_NOTHEX789abcdef0123456789abcdef_secret",
      "rk_dev_0123456789abcdef0123456789abcdef_",
      "eyJhbGciOiJIUzI1NiJ9.e30.signature",
    ]) {
      expect(parseApiKeyCredential(bad)).toBeNull();
    }
  });

  it("keeps a secret containing the separator intact", () => {
    // base64url includes `_`, so the split cannot be "on the last underscore".
    // The public id is hex and fixed-length, which makes the boundary exact no
    // matter what the secret contains.
    const raw = `rk_dev_0123456789abcdef0123456789abcdef_aa_bb_cc-dd`;
    expect(parseApiKeyCredential(raw)).toEqual({
      prefix: "rk_dev_",
      publicId: "0123456789abcdef0123456789abcdef",
      secret: "aa_bb_cc-dd",
    });
  });
});

describe("looksLikeApiKey", () => {
  it("tells the two credential classes apart by prefix alone", () => {
    // The router of the whole authentication path: `rk_` means key, anything
    // else is treated as a token. Told apart before either is verified.
    expect(looksLikeApiKey(mintApiKey("development").credential)).toBe(true);
    expect(looksLikeApiKey(mintApiKey("production").credential)).toBe(true);
    expect(looksLikeApiKey("eyJhbGciOiJIUzI1NiJ9.e30.sig")).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
  });
});

describe("hashSecret and secretMatches", () => {
  it("is deterministic for the same secret and salt", () => {
    expect(hashSecret("s3cret", "salty")).toBe(hashSecret("s3cret", "salty"));
  });

  it("gives two identical secrets different hashes under different salts", () => {
    // Why the salt column exists at all (data-model): without it, two keys
    // that happened to share a secret would share a hash.
    expect(hashSecret("same", "salt-a")).not.toBe(hashSecret("same", "salt-b"));
  });

  it("refuses a wrong secret, and refuses one of the wrong length without throwing", () => {
    const minted = mintApiKey("development");
    const secret = parseApiKeyCredential(minted.credential)!.secret;
    expect(secretMatches(secret, minted.salt, minted.secretHash)).toBe(true);
    expect(secretMatches(`${secret}x`, minted.salt, minted.secretHash)).toBe(
      false,
    );
    // timingSafeEqual THROWS on unequal buffer lengths. Comparing hashes
    // rather than secrets keeps both sides 32 bytes forever, so a short or
    // absurd presented secret is a `false`, not a 500.
    expect(secretMatches("", minted.salt, minted.secretHash)).toBe(false);
    expect(secretMatches("x".repeat(4096), minted.salt, minted.secretHash)).toBe(
      false,
    );
  });
});

describe("prefixMatchesKind", () => {
  it("holds the mapping in one place", () => {
    expect(KEY_PREFIXES.development).toBe("rk_dev_");
    expect(KEY_PREFIXES.production).toBe("rk_live_");
    expect(prefixMatchesKind("rk_dev_", "development")).toBe(true);
    expect(prefixMatchesKind("rk_live_", "production")).toBe(true);
    // A row whose prefix disagrees with its environment is a data fault, and
    // the point of storing the prefix is that it is detectable rather than
    // assumed (data-model).
    expect(prefixMatchesKind("rk_live_", "development")).toBe(false);
    expect(prefixMatchesKind("rk_dev_", "production")).toBe(false);
  });
});
