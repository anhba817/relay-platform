import { describe, expect, it } from "vitest";

import { ALLOWED_TYPES, KIND_CAPS, kindOf } from "./kinds";

describe("the allowed types", () => {
  it("is the ten FR-MED-02 names and no more", () => {
    expect(Object.keys(ALLOWED_TYPES).sort()).toEqual([
      "audio/mp4",
      "audio/mpeg",
      "audio/ogg",
      "audio/wav",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/webm",
    ]);
  });

  it("gives every allowed type a kind that has a cap", () => {
    // The reason the two live in one file: a type with no cap would be accepted and
    // then measured against `undefined`.
    for (const [type, kind] of Object.entries(ALLOWED_TYPES)) {
      expect(KIND_CAPS[kind], `${type} has no cap`).toBeGreaterThan(0);
    }
  });

  it("carries FR-MED-02's three caps exactly", () => {
    expect(KIND_CAPS).toEqual({
      image: 10 * 1024 * 1024,
      audio: 25 * 1024 * 1024,
      video: 100 * 1024 * 1024,
    });
  });

  it("answers null for a type outside the set", () => {
    expect(kindOf("application/x-msdownload")).toBeNull();
    expect(kindOf("image/tiff")).toBeNull();
    expect(kindOf("")).toBeNull();
  });

  it("does not answer for a prototype key, which a bare object lookup would", () => {
    // `ALLOWED_TYPES` is an object literal, so `kindOf("constructor")` would return a
    // function if the lookup were not guarded by the `??`. It is a truthy non-kind,
    // and it would reach the cap lookup and find nothing.
    expect(kindOf("constructor")).toBeNull();
    expect(kindOf("toString")).toBeNull();
  });
});
