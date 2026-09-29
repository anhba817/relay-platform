import { describe, expect, it } from "vitest";

import { gifOf, jpegOf, pngOf, webpOf } from "./fixtures.js";
import {
  canThumbnail,
  decodableTypes,
  THUMBNAIL_BOUND,
  thumbnailOf,
} from "./thumbnail.js";

// TWO OF THE FOUR ALLOWED IMAGE TYPES ARE COVERED HERE, AND THAT IS A FACT ABOUT THE
// FIXTURES RATHER THAN ABOUT THE CODE.
//
// `fixtures.ts` synthesises headers. `pngOf` deflates real pixel rows and `gifOf` writes a
// one-colour table, so both decode — measured at 800x600: 3,618 B and 198 B thumbnails.
// `jpegOf` is "SOI, JFIF APP0, a quantisation table, SOF0" with **no entropy-coded scan**
// and `webpOf` is a `VP8` header with no VP8 stream; a real decoder refuses both with
// `corrupt header`. That is 4.13's sentence — *"every fixture is a header this repository
// wrote"* — and it turns out to be true of two of the four, not all of them.
//
// **THE FIX IS NOT TO WIDEN THE FIXTURES.** Writing a baseline JPEG encoder in order to
// test a JPEG decoder is the tail wagging the dog, and the encoder would then be the thing
// under test. `thumbnail.itest.ts` covers all four with real bytes against a real store.
describe("what this platform can make a thumbnail of", () => {
  it("asks the decoder rather than carrying a list (FR-007)", () => {
    const types = decodableTypes();
    // The four the api's `ALLOWED_TYPES` admits. The intersection happens at the slot
    // route — this service cannot import that list and does not need to.
    for (const t of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      expect(types.has(t), `${t} is allowed upstream and must be decodable`).toBe(true);
    }
    // And the set really is derived: libvips reads formats this platform never admits,
    // so a list written by hand here would have been shorter than the truth.
    expect(types.size).toBeGreaterThan(4);
  });

  it("refuses to attempt a type the probe could not name", () => {
    expect(canThumbnail(null)).toBe(false);
    expect(canThumbnail("audio/mpeg")).toBe(false);
    expect(canThumbnail("image/png")).toBe(true);
  });
});

describe("turning an image into a thumbnail", () => {
  it.each([
    ["png", pngOf],
    ["gif", gifOf],
  ])("bounds a large %s on its long edge", async (_name, make) => {
    const outcome = await thumbnailOf(make(800, 600));
    expect(outcome.kind).toBe("made");
    if (outcome.kind !== "made") return;
    expect(Math.max(outcome.width, outcome.height)).toBe(THUMBNAIL_BOUND);
    // 800x600 is 4:3, so the bounded box is 320x240. `fit: inside` preserves the ratio,
    // which is what lets a client reserve the right box before the bytes arrive.
    expect([outcome.width, outcome.height]).toEqual([320, 240]);
    expect(outcome.bytes.length).toBeGreaterThan(0);
  });

  it.each([
    ["png", pngOf],
    ["gif", gifOf],
  ])("makes nothing for a %s already inside the bound", async (_name, make) => {
    // R2's crossover, as a behaviour rather than a figure: at or below 320 the output is
    // 97.3% of the parent and the same pixels, so the tenant would store the image twice
    // to save 2.6%. `within-bound` is not a failure and must not be recorded as one.
    const outcome = await thumbnailOf(make(200, 150));
    expect(outcome.kind).toBe("within-bound");
  });

  it("bounds an image that is wide but not tall", async () => {
    const outcome = await thumbnailOf(pngOf(900, 100));
    expect(outcome.kind).toBe("made");
    if (outcome.kind !== "made") return;
    // Only the long edge is bounded. A test that asserted 320x320 would be asserting a
    // crop, which this does not do.
    expect([outcome.width, outcome.height]).toEqual([320, 36]);
  });

  it.each([
    ["jpeg", jpegOf],
    ["webp", webpOf],
  ])("fails cleanly on a %s fixture that is only a header", async (_name, make) => {
    // NOT A SKIPPED TEST. These two fixtures cannot be decoded, and the behaviour that
    // matters is that an undecodable object produces a recorded reason rather than an
    // exception that kills the sweep.
    const outcome = await thumbnailOf(make(800, 600));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBe("decode_failed");
  });

  it("fails cleanly on bytes that are not an image at all", async () => {
    const outcome = await thumbnailOf(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(outcome.kind).toBe("failed");
  });
});
