import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// The API key as a string, and the arithmetic behind it (chapter 3.2).
// Framework-free on purpose: this is where the credential's rules live, and
// they are testable without a server, a database or a request.
//
//   rk_dev_<public_id>_<secret>
//   └──┬──┘└────┬────┘ └──┬───┘
//      │        │          └─ 32 random bytes, base64url. Shown ONCE, hashed
//      │        │             at rest, never recoverable (FR-AUT-02).
//      │        └─ 16 random bytes, HEX. Indexed, globally unique, NOT secret.
//      └─ FR-AUT-03's visible prefix: which environment am I about to hit?
//
// WHY the public id is hex when the secret is base64url: the two parts have to
// be separable by a machine, and base64url's alphabet INCLUDES the separator
// `_`. Splitting on the last underscore would corrupt any secret containing
// one; splitting on the first would corrupt any public id containing one. Hex
// has no `_` and a fixed length, so the boundary is exact whatever the secret
// happens to contain. (data-model.md said "split on the last separator"; the
// first mint that produced a secret with an underscore said otherwise.)

export const KEY_PREFIXES = {
  development: "rk_dev_",
  production: "rk_live_",
} as const;

export type EnvironmentKind = keyof typeof KEY_PREFIXES;
export type KeyPrefix = (typeof KEY_PREFIXES)[EnvironmentKind];

const PUBLIC_ID_BYTES = 16;
const SECRET_BYTES = 32;
const SALT_BYTES = 16;

const CREDENTIAL = /^(rk_dev_|rk_live_)([0-9a-f]{32})_(.+)$/;

export interface MintedKey {
  /** The whole credential, the only time it exists outside a hash. */
  credential: string;
  publicId: string;
  prefix: KeyPrefix;
  salt: string;
  secretHash: string;
}

export function mintApiKey(kind: EnvironmentKind): MintedKey {
  const prefix = KEY_PREFIXES[kind];
  const publicId = randomBytes(PUBLIC_ID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const salt = randomBytes(SALT_BYTES).toString("base64url");
  return {
    credential: `${prefix}${publicId}_${secret}`,
    publicId,
    prefix,
    salt,
    secretHash: hashSecret(secret, salt),
  };
}

export interface ParsedCredential {
  prefix: KeyPrefix;
  publicId: string;
  secret: string;
}

/** Returns null rather than throwing. A thrown error would carry the presented
 * string into a stack trace, and a stack trace is a log line (NFR-SEC-06). */
export function parseApiKeyCredential(raw: string): ParsedCredential | null {
  const match = CREDENTIAL.exec(raw);
  if (!match) return null;
  return {
    prefix: match[1] as KeyPrefix,
    publicId: match[2]!,
    secret: match[3]!,
  };
}

/** Which class is this? Decided by the prefix, before anything is verified —
 * the whole reason FR-AUT-03 puts a visible prefix on the credential. */
export function looksLikeApiKey(raw: string): boolean {
  return raw.startsWith("rk_");
}

/** Salted SHA-256, not bcrypt or argon2 — and that is deliberate (research R3).
 * A password KDF's slowness buys resistance to GUESSING a low-entropy secret.
 * This secret is 256 bits from `randomBytes`; no work factor makes it more
 * unguessable, and the cost would be paid on every authenticated request. What
 * NFR-SEC-02 asks for is a salted hash, which this is. */
export function hashSecret(secret: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

/** Constant-time comparison of the HASHES, never of the secrets. Two hashes are
 * always the same length, so `timingSafeEqual` — which throws on a length
 * mismatch — cannot be handed an absurd presented secret and turned into a 500. */
export function secretMatches(
  secret: string,
  salt: string,
  expectedHash: string,
): boolean {
  const presented = Buffer.from(hashSecret(secret, salt), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/** The prefix duplicates the environment's kind, and storing it is what makes a
 * disagreement between them detectable instead of assumed (data-model). */
export function prefixMatchesKind(prefix: string, kind: EnvironmentKind): boolean {
  return prefix === KEY_PREFIXES[kind];
}
