import { describe, expect, it } from "vitest";

import { withoutRequestId } from "./compare";

// The oracle's own tests. Pure — no database, no HTTP — because the thing being
// checked is one comparison rule, and a rule that needs a stack to test is a rule
// nobody re-reads.

describe("withoutRequestId", () => {
  it("makes two bodies differing only in request_id equal", () => {
    const foreign = {
      code: "not_found",
      message: "channel not found",
      docs_url: "https://relay.example/docs/errors/not_found",
      request_id: "req_aaa",
    };
    const absent = { ...foreign, request_id: "req_bbb" };
    expect(withoutRequestId(foreign)).toEqual(withoutRequestId(absent));
  });

  it("leaves two bodies differing in message unequal", () => {
    // The case that matters: `messages.service.ts` keeps a CONSTANT message for
    // exactly this reason — echoing the id back would make the foreign answer
    // differ from the absent one, and "different" is itself a disclosure.
    const foreign = { code: "not_found", message: "channel abc not found", request_id: "req_a" };
    const absent = { code: "not_found", message: "channel not found", request_id: "req_b" };
    expect(withoutRequestId(foreign)).not.toEqual(withoutRequestId(absent));
  });

  it("leaves two bodies differing in code unequal", () => {
    const forbidden = { code: "forbidden", message: "no", request_id: "req_a" };
    const missing = { code: "not_found", message: "no", request_id: "req_b" };
    expect(withoutRequestId(forbidden)).not.toEqual(withoutRequestId(missing));
  });

  it("passes a non-object body through untouched", () => {
    // A 204 has no body and a proxy may hand back a string. Neither is an error
    // envelope, and neither should throw on the way to a comparison.
    expect(withoutRequestId(null)).toBeNull();
    expect(withoutRequestId("gateway timeout")).toBe("gateway timeout");
    expect(withoutRequestId(undefined)).toBeUndefined();
  });

  it("does not mutate its argument", () => {
    const body = { code: "not_found", request_id: "req_a" };
    withoutRequestId(body);
    expect(body.request_id).toBe("req_a");
  });
});
