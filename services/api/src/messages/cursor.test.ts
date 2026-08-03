import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor } from "./cursor";

// The codec is dull on purpose — but "dull" still has to round-trip and
// still has to refuse everything else, because a cursor that decodes to
// the wrong number serves the wrong page in silence.
describe("history cursors (chapter 2.4)", () => {
  it("round-trips a sequence position", () => {
    for (const seq of [0, 1, 42, 1_000_000]) {
      expect(decodeCursor(encodeCursor(seq))).toBe(seq);
    }
  });

  it("is opaque — the token does not read as its contents", () => {
    expect(encodeCursor(363)).not.toContain("363");
  });

  it("refuses anything it did not mint", () => {
    for (const junk of [
      "",
      "363",
      "not-base64!",
      Buffer.from("s:abc").toString("base64url"),
    ]) {
      expect(decodeCursor(junk)).toBeNull();
    }
  });
});
