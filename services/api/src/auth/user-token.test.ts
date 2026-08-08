import { base64url } from "jose";
import { describe, expect, it } from "vitest";

import {
  MAX_TOKEN_LIFETIME_SECONDS,
  environmentClaim,
  mintUserToken,
  verifyUserToken,
} from "./user-token";

// End-user tokens (chapter 3.2), Docker-free. The environment's signing secret
// is just a string here; where it comes from is the repository's business.

const SECRET = "environment-signing-secret-for-the-unit-lane";
const ENV = "11111111-1111-1111-1111-111111111111";

describe("mintUserToken", () => {
  it("mints a token that verifies against the same secret and environment", () => {
    return (async () => {
      const { token, expiresAt } = await mintUserToken(SECRET, {
        user: "tuan",
        environmentId: ENV,
        ttlSeconds: 3600,
      });
      const claims = await verifyUserToken(token, SECRET, ENV);
      expect(claims).not.toBeNull();
      expect(claims!.sub).toBe("tuan");
      expect(claims!.env).toBe(ENV);
      expect(claims!.exp - claims!.iat).toBe(3600);
      expect(new Date(expiresAt).getTime()).toBe(claims!.exp * 1000);
    })();
  });

  it("refuses to mint a lifetime over 24 hours", async () => {
    // FR-AUT-07 bounds the lifetime. Refusing at MINT time as well as at verify
    // time means the api never hands out a token it would later reject.
    await expect(
      mintUserToken(SECRET, {
        user: "tuan",
        environmentId: ENV,
        ttlSeconds: MAX_TOKEN_LIFETIME_SECONDS + 1,
      }),
    ).rejects.toThrow(/24 hours|86400/);
    expect(MAX_TOKEN_LIFETIME_SECONDS).toBe(86_400);
  });
});

describe("verifyUserToken", () => {
  const mint = (over: Record<string, unknown> = {}, ttl = 3600) =>
    mintUserToken(SECRET, {
      user: "tuan",
      environmentId: ENV,
      ttlSeconds: ttl,
      ...over,
    });

  it("refuses a malformed token", async () => {
    for (const bad of ["", "not.a.token", "a.b", "eyJhbGciOiJIUzI1NiJ9"]) {
      expect(await verifyUserToken(bad, SECRET, ENV)).toBeNull();
    }
  });

  it("refuses a token signed with another secret", async () => {
    const { token } = await mintUserToken("someone-elses-secret", {
      user: "tuan",
      environmentId: ENV,
      ttlSeconds: 3600,
    });
    expect(await verifyUserToken(token, SECRET, ENV)).toBeNull();
  });

  it("refuses a token minted for a different environment", async () => {
    // FR-AUT-08. The environment claim is checked AFTER the signature: the
    // claim chooses which secret to try, the signature decides whether to
    // believe it.
    const other = "22222222-2222-2222-2222-222222222222";
    const { token } = await mint({ environmentId: other });
    expect(await verifyUserToken(token, SECRET, other)).not.toBeNull();
    expect(await verifyUserToken(token, SECRET, ENV)).toBeNull();
  });

  it("refuses an expired token", async () => {
    const { token } = await mintUserToken(SECRET, {
      user: "tuan",
      environmentId: ENV,
      ttlSeconds: 60,
      // Issued and expired in the past — the same shape a token that aged out
      // in a reader's terminal has.
      issuedAt: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(await verifyUserToken(token, SECRET, ENV)).toBeNull();
  });

  it("refuses a lifetime over 24 hours even when the signature is good", async () => {
    // Invariant 7's last clause: a token this api would never mint, minted by
    // something that holds the secret, is still refused on presentation.
    const issuedAt = Math.floor(Date.now() / 1000);
    const { token } = await mintUserToken(SECRET, {
      user: "tuan",
      environmentId: ENV,
      ttlSeconds: MAX_TOKEN_LIFETIME_SECONDS + 3600,
      issuedAt,
      allowOverLongLifetime: true,
    });
    expect(await verifyUserToken(token, SECRET, ENV)).toBeNull();
  });

  it("refuses a token with an empty or missing subject", async () => {
    expect(await verifyUserToken((await mint({ user: "" })).token, SECRET, ENV))
      .toBeNull();
  });

  it("refuses alg: none — the algorithm-confusion case", async () => {
    // Invariant 8, and the chapter's TRAP. A verifier that trusts the token's
    // own header about how to check it can be told not to check at all.
    const unsigned = `${base64url.encode(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    )}.${base64url.encode(
      JSON.stringify({
        sub: "attacker",
        env: ENV,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )}.`;
    expect(await verifyUserToken(unsigned, SECRET, ENV)).toBeNull();
  });

  it("refuses a token claiming an asymmetric algorithm", async () => {
    // The same family of attack: swap HS256 for RS256 and hope the verifier
    // treats the secret as a public key. The allow-list refuses before any
    // key material is considered.
    const header = base64url.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = base64url.encode(
      JSON.stringify({
        sub: "attacker",
        env: ENV,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    expect(
      await verifyUserToken(`${header}.${body}.c2lnbmF0dXJl`, SECRET, ENV),
    ).toBeNull();
  });
});

describe("environmentClaim", () => {
  it("reads the environment from an unverified token, and nothing else", async () => {
    // How the api knows WHICH secret to check a signature with. This is an
    // unverified read by necessity, so it returns one field and is never used
    // to make a trust decision on its own.
    const { token } = await mintUserToken(SECRET, {
      user: "tuan",
      environmentId: ENV,
      ttlSeconds: 3600,
    });
    expect(environmentClaim(token)).toBe(ENV);
    expect(environmentClaim("garbage")).toBeNull();
    expect(
      environmentClaim(
        `${base64url.encode(JSON.stringify({ alg: "HS256" }))}.${base64url.encode(
          JSON.stringify({ sub: "x" }),
        )}.sig`,
      ),
    ).toBeNull();
  });
});
