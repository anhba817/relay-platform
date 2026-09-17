import { describe, expect, it } from "vitest";

import {
  decodeRequestLogCursor,
  encodeRequestLogCursor,
  type RequestLogPosition,
} from "./cursor";

const POSITION: RequestLogPosition = {
  ts: new Date("2026-09-16T01:02:03.456Z"),
  requestId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
};

describe("the request log cursor", () => {
  it("round-trips a position", () => {
    const decoded = decodeRequestLogCursor(encodeRequestLogCursor(POSITION));
    expect(decoded).not.toBeNull();
    expect(decoded?.ts.toISOString()).toBe("2026-09-16T01:02:03.456Z");
    expect(decoded?.requestId).toBe(POSITION.requestId);
  });

  it("keeps the millisecond, which is the whole resolution the column has", () => {
    const decoded = decodeRequestLogCursor(encodeRequestLogCursor(POSITION));
    expect(decoded?.ts.getTime()).toBe(POSITION.ts.getTime());
  });

  /** T006 MEASURED THIS ON THE LANE: 42 `(environment_id, ts)` pairs hold more than one
   * row, 89 rows in total. A cursor that carried `ts` alone would emit the same token for
   * both rows below, so the next page either repeats one or skips it — and which of the
   * two depends on whether the comparison is `>` or `>=`, neither of which is right for
   * both. The pair is what makes the boundary exact. */
  it("distinguishes two rows in the same millisecond", () => {
    const a = encodeRequestLogCursor(POSITION);
    const b = encodeRequestLogCursor({
      ts: new Date(POSITION.ts.getTime()),
      requestId: "00000000-1111-4222-8333-444444444444",
    });
    expect(a).not.toBe(b);
    expect(decodeRequestLogCursor(b)?.requestId).toBe(
      "00000000-1111-4222-8333-444444444444",
    );
  });

  it("is opaque: the position is not readable off the token", () => {
    const token = encodeRequestLogCursor(POSITION);
    expect(token).not.toContain(POSITION.requestId);
    expect(token).not.toContain("2026");
  });

  describe("refuses anything it did not produce", () => {
    // Each of these is a token a caller could plausibly send: a guess, a truncation, a
    // token from the OTHER cursor on this platform, and a payload.
    it.each([
      ["empty", ""],
      ["not base64url", "!!!!"],
      ["the message cursor's token", Buffer.from("s:42", "utf8").toString("base64url")],
      ["no prefix", Buffer.from("1758589323456:3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8", "utf8").toString("base64url")],
      ["no request id", Buffer.from("rl:1758589323456", "utf8").toString("base64url")],
      ["a request id that is not a uuid", Buffer.from("rl:1758589323456:not-a-uuid-at-all-not-a-uuid-at-all!", "utf8").toString("base64url")],
      ["a timestamp that is not a number", Buffer.from("rl:yesterday:3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8", "utf8").toString("base64url")],
      ["a timestamp past the safe integer", Buffer.from("rl:99999999999999999999:3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8", "utf8").toString("base64url")],
      ["a timestamp the column cannot hold — year 33658, and a safe integer", Buffer.from("rl:999999999999999:3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8", "utf8").toString("base64url")],
      ["a timestamp older than the table's own CHECK", Buffer.from("rl:0:3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8", "utf8").toString("base64url")],
      ["a quote in the request id", Buffer.from("rl:1758589323456:3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7'8", "utf8").toString("base64url")],
      // THIRTY-SIX CHARACTERS OF THE RIGHT ALPHABET AND THE WRONG SHAPE. The pattern that
      // splits the token admits `[0-9a-fA-F-]{36}`; only the second check knows where the
      // dashes go. The branch report is what said this arm had never run.
      ["thirty-six dashes", Buffer.from(`rl:1758589323456:${"-".repeat(36)}`, "utf8").toString("base64url")],
      ["thirty-six hex characters with no dashes", Buffer.from("rl:1758589323456:3f2a1b4c5d6e4f708192a3b4c5d6e7f8abcd", "utf8").toString("base64url")],
      ["a statement after the pair", Buffer.from("rl:1758589323456:3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8'; DROP TABLE api_requests --", "utf8").toString("base64url")],
    ])("%s", (_name, token) => {
      expect(decodeRequestLogCursor(token)).toBeNull();
    });
  });

  /** THE POSITIVE CONTROL FOR THE BLOCK ABOVE. Ten refusals prove nothing if the decoder
   * refuses everything — which is exactly what an over-tight pattern would do, silently,
   * and the symptom would be a request log that never pages. */
  it("still accepts a token it produced, after all of those", () => {
    expect(decodeRequestLogCursor(encodeRequestLogCursor(POSITION))).not.toBeNull();
  });

  it("accepts an upper-case uuid and normalises it", () => {
    const token = Buffer.from(
      "rl:1758589323456:3F2A1B4C-5D6E-4F70-8192-A3B4C5D6E7F8",
      "utf8",
    ).toString("base64url");
    expect(decodeRequestLogCursor(token)?.requestId).toBe(POSITION.requestId);
  });
});
