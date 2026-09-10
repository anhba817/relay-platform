import { describe, expect, it } from "vitest";

import {
  CLOSE_CODES,
  DEFAULT_DOCS_BASE_URL,
  docsUrl,
  ERROR_CODES,
  type ErrorCode,
} from "./codes.js";

// The failure vocabulary stays coherent: EIR-WS-06's four classes are all
// present, exactly once, with distinct meanings — and error codes never
// collide or go blank as chapters add to the registry.

describe("close codes cover EIR-WS-06's four classes", () => {
  // AND ONE MORE THAN FOUR, SINCE THE PREVIOUS CHAPTER. `4003` is a ban, which is none of
  // EIR-WS-06's classes: the token verifies, names a real user and is in date, and the
  // user is refused anyway. Reusing 4001 would tell a client to re-authenticate, which
  // succeeds at minting a token and fails again at connect.
  //
  // THIS ASSERTION IS WHY THE NUMBER IS DELIBERATE. It failed on the build that added
  // 4003 — an exact-set assertion is the only kind that makes a new close code a decision
  // rather than an accident, and updating it is the act of making that decision.
  it("contains exactly 4001, 4002, 4003, 4004, 4008, 4009", () => {
    expect(Object.keys(CLOSE_CODES).map(Number).sort()).toEqual([
      4001, 4002, 4003, 4004, 4008, 4009,
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

describe("every code the REST filter can emit is registered (FR-024)", () => {
  // The filter maps a status to a code when the thrower names none. Four of these
  // were absent from the registry and went out on the wire from chapter 2.2, each
  // with a `docs_url` derived from a code the reference could not document.
  //
  // NAMED HERE RATHER THAN IMPORTED, because `@relay/protocol` must not depend on a
  // service. That makes this list a second copy of the ladder — so it is asserted in
  // the direction that catches drift: the ladder is TYPED `ErrorCode`, which means a
  // code it emits and this registry lacks stops compiling in the api. This test
  // covers the other direction, that the four are not quietly deleted from here.
  const EMITTED_BY_STATUS = [
    "invalid_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "internal_error",
  ] as const;

  it.each(EMITTED_BY_STATUS)("registers %s", (code) => {
    expect(ERROR_CODES).toHaveProperty(code);
    expect(ERROR_CODES[code as ErrorCode]).not.toBe("");
  });
});

describe("the three refusals this chapter's channel adds", () => {
  // NAMED HERE RATHER THAN COUNTED. A `toHaveLength(13)` would go red for the right
  // reason on a deletion and for the wrong reason on any addition, so every later
  // chapter that adds a code would edit this number — and a number edited on every
  // change is a number nobody reads. What matters about these three is that they are
  // three and not one: a client acts differently on each.
  const ADDED = ["not_a_member", "channel_archived", "user_banned"] as const;

  it.each(ADDED)("registers %s with a description a client can act on", (code) => {
    expect(ERROR_CODES).toHaveProperty(code);
    expect(ERROR_CODES[code as ErrorCode]).not.toBe("");
  });

  it("keeps them distinct from forbidden, which is what they exist instead of", () => {
    // Reusing `forbidden` for all three is the design this chapter argues against, so
    // the assertion is that no two of them share a description with it or each other
    // — the failure mode is a copied line, not a missing key.
    const meanings = [...ADDED, "forbidden"].map((c) => ERROR_CODES[c as ErrorCode]);
    expect(new Set(meanings).size).toBe(meanings.length);
  });

  // THREE CLAIMS, THREE TITLES, and the reason is what a failure looks like from
  // outside the repository. One case asserting all three went red on the wording of
  // `not_a_member` under a title about bans and archives — a CI summary has no tree
  // to grep, so the title is the whole report.
  //
  // Asserting on wording is unusual and deliberate: these strings are the contract
  // `docs_url` resolves to, and a client's developer reads them rather than the code.

  it("says a ban is tenant-scope, not channel-scope", () => {
    expect(ERROR_CODES.user_banned).toMatch(/environment/);
  });

  it("says an archive leaves history readable", () => {
    expect(ERROR_CODES.channel_archived).toMatch(/history is still readable/);
  });

  it("registers the refusal a bot-only credential gives a person", () => {
    // THIS CHAPTER'S ONE CODE. `sender_not_permitted` is the fifth check on the send
    // path and the only one whose subject is a fact about the SENDER rather than the
    // channel — so it needs a code of its own, for the reason the credentials chapter
    // gave when it added `wrong_credential_type` instead of a generic 403.
    expect(ERROR_CODES).toHaveProperty("sender_not_permitted");
    expect(ERROR_CODES.sender_not_permitted).not.toBe("");
  });

  it("never lets not_a_member announce that the channel exists", () => {
    // THE LEAK FR-003 FORBIDS, in the one place it can be written by accident. A
    // private channel the caller cannot see must answer the not-found envelope, so a
    // description saying "the channel exists and…" would put the oracle in the text
    // even when the status code is right.
    expect(ERROR_CODES.not_a_member).not.toMatch(/\bexists?\b/);
  });
});

describe("the docs URL is built in one place, with the code as the anchor", () => {
  it("appends the code VERBATIM as an ANCHOR — no slug transform, no case change", () => {
    // THIS DESCRIBE SAID "ANCHOR" AND THIS ASSERTION CHECKED A PATH, for twenty-two
    // chapters. `docs/08-error-reference.md` is one document with `## <code>` headings,
    // so `…/errors/not_found` named a page that does not exist — 27 codes, 27 dead
    // links — and the test agreed with the defect because it was written beside the
    // function. The title and the assertion disagreed and nothing compared them.
    for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
      expect(docsUrl(code)).toBe(`${DEFAULT_DOCS_BASE_URL}#${code}`);
      expect(docsUrl(code).endsWith(`#${code}`)).toBe(true);
    }
  });

  it("reads the base URL per call, not at import", () => {
    // A `const` evaluated at import cannot be changed by a test that sets the variable
    // in `beforeAll`, and a preview deployment cannot point its error links at its own
    // docs. The assertion is that the value MOVES — which a module-level constant makes
    // impossible however the test is written.
    const saved = process.env["RELAY_DOCS_BASE_URL"];
    try {
      process.env["RELAY_DOCS_BASE_URL"] = "https://preview.example/errors";
      expect(docsUrl("not_found")).toBe("https://preview.example/errors#not_found");
    } finally {
      if (saved === undefined) delete process.env["RELAY_DOCS_BASE_URL"];
      else process.env["RELAY_DOCS_BASE_URL"] = saved;
    }
    // And back to the default the moment it is unset, so one test cannot leak into
    // another through the environment.
    expect(docsUrl("not_found")).toBe(`${DEFAULT_DOCS_BASE_URL}#not_found`);
  });

  it("gives every code a distinct URL", () => {
    const urls = (Object.keys(ERROR_CODES) as ErrorCode[]).map(docsUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("the refusal this chapter's cap adds", () => {
  // NAMED, NOT COUNTED, for the reason the channel block above gives.
  //
  // What matters about this one is that it is **not** `rate_limited`. The two sit one
  // word apart in the register and mean opposite things: `rate_limited` throttles
  // frames and says "slow down and retry", which is exactly what a client at the
  // connection cap must not do — five sockets are already open and no amount of
  // waiting closes one. The remedy is a client action, not a delay.
  it("registers connection_limit_reached with a description a client can act on", () => {
    expect(ERROR_CODES).toHaveProperty("connection_limit_reached");
    expect(ERROR_CODES.connection_limit_reached).not.toBe("");
  });

  it("keeps it distinct from rate_limited, which is what it exists instead of", () => {
    expect(ERROR_CODES.connection_limit_reached).not.toBe(ERROR_CODES.rate_limited);
  });

  it("names a remedy the client can perform rather than a delay to wait out", () => {
    // THE ONE ASSERTION ABOUT THE WORDS, and it is the whole reason for a separate
    // code. A message telling a capped client to retry sends it into a loop against a
    // wall, which is the failure `codes.ts` has now argued against five times.
    expect(ERROR_CODES.connection_limit_reached).toContain("close one");
    expect(ERROR_CODES.rate_limited).toContain("retry");
  });
});

describe("the refusal this chapter's edit path adds", () => {
  // NAMED, NOT COUNTED, for the reason the blocks above give.
  //
  // FR-022. The registry's own rule is that a specific code beats the generic one
  // where the remedy differs, and here it differs absolutely: `forbidden`'s published
  // remedy is a change of credential or of permission, and **neither makes a message
  // yours**. A client told `forbidden` asks an administrator for a role; a client told
  // `not_message_author` stops asking.
  it("names the non-author refusal separately from the generic 403", () => {
    expect(ERROR_CODES).toHaveProperty("not_message_author");
    expect(ERROR_CODES.not_message_author).not.toBe(ERROR_CODES.forbidden);
    expect(ERROR_CODES.not_message_author).toMatch(/author/);
  });

  // A SECOND CODE IN ONE CHAPTER, which the plan did not expect — and the count that
  // used to sit at the top of this file is exactly what would have caught it as an
  // arithmetic edit rather than as a decision. Named instead: what makes
  // `message_deleted` a code of its own is that a client acts on it, and the three it
  // could have reused all misdirect that action.
  //
  //   not_message_author   false. The author of a tombstone IS its author, and the
  //                        client goes looking for a permission problem.
  //   not_found            a lie with a witness — FR-011 keeps a deleted message in
  //                        history, so the client holds the thing it is told is absent.
  //   forbidden            the same objection as above: no credential un-deletes.
  //
  // `codes.ts` argues the fourth candidate, a bare 409, which is about the filter
  // rather than about the client.
  it("names a deleted message's refusal apart from every refusal about the caller", () => {
    expect(ERROR_CODES).toHaveProperty("message_deleted");
    for (const other of ["not_message_author", "not_found", "forbidden"] as const) {
      expect(ERROR_CODES.message_deleted).not.toBe(ERROR_CODES[other]);
    }
    // THE WORDING IS THE CONTRACT: the remedy is to stop offering an edit, and the
    // sentence has to say the history is unharmed or a client re-reads it as a loss.
    expect(ERROR_CODES.message_deleted).toMatch(/deleted/);
    expect(ERROR_CODES.message_deleted).toMatch(/history/);
  });
});

describe("the refusal this chapter's attachments add", () => {
  // NAMED, NOT COUNTED, for the reason the blocks above give — and this chapter is the
  // one that pays for it twice over: the count it replaced would have read a single
  // arithmetic edit where what happened is that a field the CONTRACT publishes got an
  // answer of its own.
  //
  // `invalid_request` IS THE WRONG ANSWER FOR `media_id`, and that is the whole
  // argument. Every other refusal in this pipe is about a body the contract does not
  // allow; `media_id` is in FR-MSG-11 and the caller made no mistake. A 400 saying
  // "invalid" tells them to fix a request that is already correct.
  it("names the unhosted-media refusal apart from a malformed request", () => {
    expect(ERROR_CODES).toHaveProperty("media_not_available");
    expect(ERROR_CODES.media_not_available).not.toBe(ERROR_CODES.invalid_request);
    expect(ERROR_CODES.media_not_available).toMatch(/media/);
  });
});

describe("the five refusals this chapter's webhook surface adds", () => {
  // NAMED, NOT COUNTED, for the reason the blocks above give — and here the names were
  // decided somewhere else. `docs/08-error-reference.md` published a section for each of
  // these five before the registry held any of them, so what this asserts is CLOSURE in
  // the direction no gate covers: `check-error-codes` reads the built `dist` against the
  // docs and counts, so a code documented and unregistered is indistinguishable from a
  // section nobody has written.
  const WEBHOOK_CODES = [
    "webhook_endpoint_limit_reached",
    "webhook_url_invalid",
    "webhook_url_insecure",
    "webhook_url_private_address",
    "webhook_event_types_empty",
  ] as const;

  it.each(WEBHOOK_CODES)("registers %s with a description a client can act on", (code) => {
    expect(ERROR_CODES).toHaveProperty(code);
    expect(ERROR_CODES[code]).not.toBe("");
  });

  it("keeps all five distinct from internal_error, which is what they shipped as", () => {
    // THE DEFECT, AS AN ASSERTION. Every one of these was an unnamed 422, and an unnamed
    // 422 becomes `internal_error` in `ProtocolErrorFilter`'s ladder — a correct status
    // and a correct message with a body telling the client the server had broken.
    for (const code of WEBHOOK_CODES) {
      expect(ERROR_CODES[code]).not.toBe(ERROR_CODES.internal_error);
    }
    // AND DISTINCT FROM EACH OTHER. Five copied lines would satisfy the loop above.
    const meanings = WEBHOOK_CODES.map((c) => ERROR_CODES[c]);
    expect(new Set(meanings).size).toBe(meanings.length);
  });

  it("says which of the two url refusals is about the scheme", () => {
    // The pair a caller is most likely to confuse: an unparseable url and a parseable
    // one this platform will not deliver to. The wording is the contract `docs_url`
    // resolves to, and a developer reads it rather than the code.
    expect(ERROR_CODES.webhook_url_insecure).toMatch(/https/);
    expect(ERROR_CODES.webhook_url_invalid).toMatch(/absolute/);
  });
});
