import { afterEach, describe, expect, it, vi } from "vitest";

import { comparePair, credentialAttack, rowsOf } from "./attack";

// The oracle's REPORTING arm, which a passing gauntlet cannot reach.
//
// Every assertion in `gauntlet.itest.ts` asserts that `differences` is empty, so
// the code that builds a difference string only ever runs when the platform is
// broken. That is the same problem Phase 7's reintroductions solve for the suite
// as a whole, one layer down: an instrument that has never produced output has
// never had its output checked.

const answer = (status: number, body: unknown) => ({ status, body });

describe("comparing a foreign answer against an absent one", () => {
  it("reports nothing when both agree", () => {
    expect(comparePair(answer(404, { code: "not_found" }), answer(404, { code: "not_found" }))).toEqual(
      [],
    );
  });

  it("ignores request_id, which differs on every request by design", () => {
    expect(
      comparePair(
        answer(404, { code: "not_found", request_id: "a" }),
        answer(404, { code: "not_found", request_id: "b" }),
      ),
    ).toEqual([]);
  });

  it("names the statuses when they differ", () => {
    const [first] = comparePair(answer(403, {}), answer(404, {}));
    expect(first).toBe("status 403 (foreign) vs 404 (absent)");
  });

  it("names both bodies when they differ", () => {
    const differences = comparePair(answer(404, { code: "forbidden" }), answer(404, { code: "not_found" }));
    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain("forbidden");
    expect(differences[0]).toContain("not_found");
  });

  it("reports both when both differ", () => {
    expect(comparePair(answer(200, { messages: [1] }), answer(404, { code: "not_found" }))).toHaveLength(
      2,
    );
  });

  it("compares a non-object body without throwing", () => {
    // `withoutRequestId` returns a non-object unchanged, and an html error page or
    // an empty string is a real answer a misconfigured route can give.
    expect(comparePair(answer(502, "bad gateway"), answer(404, ""))).toHaveLength(2);
  });
});

describe("counting the rows in a list answer", () => {
  it("reads a bare array", () => {
    expect(rowsOf([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("reads a paginated envelope", () => {
    expect(rowsOf({ data: [1, 2], next_cursor: "x" })).toEqual([1, 2]);
  });

  it("returns nothing for a shape it does not recognise", () => {
    // The arm that matters. Zero rows from an unknown shape looks exactly like
    // zero rows from a correctly-scoped list, and only one of those is a pass.
    expect(rowsOf({ code: "not_found" })).toEqual([]);
    expect(rowsOf(null)).toEqual([]);
    expect(rowsOf("an html error page")).toEqual([]);
    expect(rowsOf({ data: "not an array" })).toEqual([]);
  });
});

describe("a credential attack that could not even mint", () => {
  // THE ARM THAT REPORTS A FAILED MINT, which is the third instrument in this file
  // that a healthy lane never reaches. `credentialAttack` asks the api for a token
  // with the ATTACKER's own credential — a legitimate request that succeeds every
  // time the platform is up — and only then presents it against the victim.
  //
  // WHY IT MATTERS THAT THIS ARM IS RIGHT. If a broken mint returned the shape of a
  // success, every credential attack in the gauntlet would read `minted: true` and
  // compare a token that does not exist against a route that refused it for the wrong
  // reason. The suite would be green and would be asserting nothing — which is the
  // failure this whole chapter is about, arriving through the instrument rather than
  // through the platform.
  //
  // Driven with a stubbed `fetch`, because the only way to fail a mint against a live
  // api is to break the api.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the mint's own status and body, and does not claim a token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: false,
          status: 401,
          json: async () => Promise.resolve({ code: "unauthorized" }),
        }),
      ),
    );

    const verdict = await credentialAttack("http://unused.invalid", "rk_dev_bad", "mai", {
      method: "GET",
      path: "/v1/channels/whatever",
    });

    expect(verdict.minted, "a failed mint reported as a successful one").toBe(false);
    expect(verdict.crossStatus).toBe(401);
    expect(verdict.crossBody).toEqual({ code: "unauthorized" });
  });
});
