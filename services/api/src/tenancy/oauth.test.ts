import { describe, expect, it } from "vitest";

import {
  profileSchema,
  providerErrorSchema,
  tokenResponseSchema,
} from "./oauth.schema";
import {
  STATE_COOKIE,
  clearStateCookie,
  mintState,
  readCookie,
  stateCookie,
  statesMatch,
} from "./state-cookie";

// Invariants 5 and 6 (chapter 3.1), in the Docker-free lane: the CSRF binding
// and the provider contract. Neither needs a database, and neither should wait
// for one — this is the lane a reader runs on every save (2.1's gate).

describe("the state binding (invariant 5)", () => {
  it("mints a value with enough entropy to be unguessable", () => {
    const a = mintState();
    const b = mintState();
    expect(a).toHaveLength(32); // 128 bits, hex
    expect(a).not.toBe(b);
  });

  it("refuses a callback whose state does not match the cookie", () => {
    const minted = mintState();
    // The attack this closes: an attacker starts the flow, takes the state
    // value, and feeds a victim the callback URL. The value is real, so a
    // server that only checked "is this well formed?" would accept it. What
    // the victim's browser does NOT have is the cookie.
    expect(statesMatch(minted, undefined)).toBe(false);
    expect(statesMatch(minted, mintState())).toBe(false);
    expect(statesMatch(undefined, minted)).toBe(false);
    expect(statesMatch("", "")).toBe(false);
    expect(statesMatch(minted, minted)).toBe(true);
  });

  it("does not leak length through an early return", () => {
    // A shorter or longer candidate is refused, not compared byte-for-byte.
    expect(statesMatch("abc", "abcd")).toBe(false);
  });

  it("sets the cookie so a script cannot read it and the provider can return through it", () => {
    const header = stateCookie("abc123", true);
    expect(header).toContain(`${STATE_COOKIE}=abc123`);
    expect(header).toContain("HttpOnly");
    // Lax, not Strict: the provider's redirect back IS a cross-site
    // navigation, and Strict would withhold the cookie exactly when it is
    // needed.
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/auth");
    expect(header).toContain("Secure");
  });

  it("omits Secure only when the base URL is plain http", () => {
    // A reader on localhost would never receive a Secure cookie over http,
    // and the flow would fail with nothing to point at.
    expect(stateCookie("abc", false)).not.toContain("Secure");
  });

  it("expires the cookie when clearing it", () => {
    expect(clearStateCookie(false)).toContain("Max-Age=0");
  });

  it("reads one cookie out of a header full of them", () => {
    const header = `other=1; ${STATE_COOKIE}=wanted; third=3`;
    expect(readCookie(header, STATE_COOKIE)).toBe("wanted");
    expect(readCookie(header, "missing")).toBeUndefined();
    expect(readCookie(undefined, STATE_COOKIE)).toBeUndefined();
    // A name that is a suffix of another must not match it.
    expect(readCookie(`x${STATE_COOKIE}=no`, STATE_COOKIE)).toBeUndefined();
  });
});

describe("the provider contract (invariant 6)", () => {
  it("recognises a provider's error body, which arrives with HTTP 200", () => {
    // GitHub answers a bad code with 200 and an error object. Parsing only the
    // success shape would read `access_token: undefined` as a token.
    const parsed = providerErrorSchema.safeParse({
      error: "bad_verification_code",
      error_description: "The code passed is incorrect or expired.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a token response with no token", () => {
    expect(
      tokenResponseSchema.safeParse({ token_type: "bearer" }).success,
    ).toBe(false);
    expect(tokenResponseSchema.safeParse({ access_token: "" }).success).toBe(
      false,
    );
    expect(
      tokenResponseSchema.safeParse({ access_token: "gho_x" }).success,
    ).toBe(true);
  });

  it("accepts an id whether the provider sends a number or a string", () => {
    // GitHub sends a number, Google a string. It is an opaque key here, so
    // both become a string rather than the api caring which provider it is.
    expect(profileSchema.parse({ id: 4711, login: "tuan" }).id).toBe("4711");
    expect(profileSchema.parse({ id: "4711", login: "tuan" }).id).toBe("4711");
  });

  it("tolerates a withheld email but not a missing id", () => {
    // FR-TEN-01: nothing beyond what the provider granted. A provider that
    // releases no email is normal, and identity does not depend on it.
    expect(
      profileSchema.safeParse({ id: 1, login: "tuan", email: null }).success,
    ).toBe(true);
    expect(profileSchema.safeParse({ login: "tuan" }).success).toBe(false);
  });

  it("rejects a profile whose email is not an email", () => {
    expect(
      profileSchema.safeParse({ id: 1, email: "not-an-email" }).success,
    ).toBe(false);
  });
});
