import { describe, expect, it } from "vitest";

import { CLOSE_CODES, ERROR_CODES, docsUrl, DEFAULT_DOCS_BASE_URL } from "./codes.js";

// The failure vocabulary stays coherent: EIR-WS-06's four classes are all
// present, exactly once, with distinct meanings — and error codes never
// collide or go blank as chapters add to the registry.

describe("close codes cover EIR-WS-06's four classes", () => {
  // AND ONE MORE THAN FOUR, SINCE CHAPTER 3.15. `4003` is a ban, which is none of
  // EIR-WS-06's classes: the token verifies, names a real user and is in date, and the
  // user is refused anyway. Reusing 4001 would tell a client to re-authenticate, which
  // succeeds at minting a token and fails again at connect.
  //
  // THIS ASSERTION IS WHY THE NUMBER IS DELIBERATE. It failed on the build that added
  // 4003 — an exact-set assertion is the only kind that makes a new close code a decision
  // rather than an accident, and updating it is the act of making that decision.
  it("contains exactly 4001, 4002, 4003, 4008, 4009", () => {
    expect(Object.keys(CLOSE_CODES).map(Number).sort()).toEqual([
      4001, 4002, 4003, 4008, 4009,
    ]);
  });

  it("gives every code a distinct, non-empty meaning", () => {
    const meanings = Object.values(CLOSE_CODES);
    expect(new Set(meanings).size).toBe(meanings.length);
    for (const meaning of meanings) expect(meaning.length).toBeGreaterThan(0);
  });
});

describe("error codes stay unique and described", () => {
  it("has no duplicate or empty descriptions", () => {
    const descriptions = Object.values(ERROR_CODES);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const d of descriptions) expect(d.length).toBeGreaterThan(0);
  });

  it("uses snake_case machine-readable keys (EIR-API-04)", () => {
    for (const code of Object.keys(ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z_]*$/);
    }
  });
});

// ── THE PLATFORM HALF OF THE CLOSURE CHECK (chapter 3.14, FR-025, SC-011) ─────
//
// Every code the platform can emit is in `ERROR_CODES`. The tutorial repository
// holds the other half — that every code has a section in the published reference,
// and that every section names a code that exists — and it lives there rather than
// here for two measured reasons: `docs/` sits above `$TURBO_ROOT$` so it cannot be
// a turbo input, and a gate whose input turbo cannot see passes from cache after
// the reference changes; and `relay-platform` is independently clonable with a
// README promising its checks pass from a clean checkout, where `../docs` does not
// exist.
//
// What CAN be checked here is the registry's own closure: `docsUrl` accepts only
// `ErrorCode`, `ProtocolErrorFilter`'s ladder is typed `ErrorCode`, and
// `protocolError` and the gateway's `sendError` both take `ErrorCode` — so a code
// that is not in this object cannot be constructed anywhere in the platform without
// failing the build. This suite checks the shape of the object those types rest on.
describe("the registry is the whole vocabulary (FR-024)", () => {
  it("holds sixteen codes", () => {
    // A number, so adding one is a visible edit rather than a silent widening. The
    // count is here and not in a comment because a comment does not fail.
    //
    // Thirteen until chapters 3.15 and 3.16 added `not_a_member`,
    // `channel_archived` and `user_banned` — three refusals a client acts on
    // differently, which is the test this registry sets.
    expect(Object.keys(ERROR_CODES)).toHaveLength(16);
  });

  it("contains the five the status ladder emits", () => {
    // `ProtocolErrorFilter` maps a status to one of these when a thrower names no
    // code. All five went out on the wire for twenty-two chapters while absent
    // from this object — and `docs_url` is derived from the code, so each one
    // shipped a link to a page that could not exist.
    for (const code of [
      "invalid_request",
      "unauthorized",
      "forbidden",
      "not_found",
      "internal_error",
    ]) {
      expect(ERROR_CODES, code).toHaveProperty(code);
    }
  });

  it("contains every code the socket surface sends", () => {
    for (const code of [
      "invalid_frame",
      "unknown_frame_type",
      "rate_limited",
      "quota_exceeded",
      // Chapter 3.16. A banned user is refused at connect, so the socket says this
      // one too — and a non-member's send over a socket answers the same way REST
      // does, which for a private channel is the not-found envelope and not a code
      // of its own.
      "user_banned",
    ]) {
      expect(ERROR_CODES, code).toHaveProperty(code);
    }
  });

  it("contains the three the channel surface adds", () => {
    // `not_a_member` has one emitter — the read-position route on a public channel —
    // and it is here rather than at that call site for the reason chapter 3.2 gave
    // when it registered `wrong_credential_type` instead of inventing it inline.
    for (const code of ["not_a_member", "channel_archived", "user_banned"]) {
      expect(ERROR_CODES, code).toHaveProperty(code);
    }
  });

  it("builds a docs_url whose fragment is the code verbatim", () => {
    // No slug transform, in either direction. The reference's `h2` headings ARE
    // the codes, and `slugifyHeading` in the tutorial site keeps `_` so that
    // stays true — a transform here would be the same transform maintained in two
    // repositories with no test able to see both sides.
    for (const code of Object.keys(ERROR_CODES) as (keyof typeof ERROR_CODES)[]) {
      expect(docsUrl(code).endsWith(`#${code}`), code).toBe(true);
    }
  });

  it("reads the base URL per call, not at import", () => {
    const before = process.env["RELAY_DOCS_BASE_URL"];
    try {
      process.env["RELAY_DOCS_BASE_URL"] = "https://preview.example/errors";
      expect(docsUrl("not_found")).toBe("https://preview.example/errors#not_found");
    } finally {
      if (before === undefined) delete process.env["RELAY_DOCS_BASE_URL"];
      else process.env["RELAY_DOCS_BASE_URL"] = before;
    }
    expect(docsUrl("not_found")).toBe(`${DEFAULT_DOCS_BASE_URL}#not_found`);
  });
});
