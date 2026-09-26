import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { dimensionsOf } from "./dimensions.js";
import { gifOf, jpegOf, pngOf, webpOf } from "./fixtures.js";

// RED PER FORMAT, NOT ONCE (T024).
//
// A reader that returns the right answer for PNG and silently returns zeros for WebP
// passes a single-format test and ships. Every format below was run red on its own by
// deleting its branch, and the three that share a container prefix — WebP and WAV both
// begin `RIFF` — were run red against each other.
//
// AND THE SIZES ARE DELIBERATELY UNEQUAL. A 100×100 fixture cannot tell a reader that
// swapped width and height from one that did not, and JPEG's `SOF0` really does put
// height before width — which is the one place in these four formats where the obvious
// order is wrong.
const W = 640;
const H = 400;

describe("dimensions, from the header and nothing else", () => {
  it("PNG — at a fixed offset, and the pixel data agrees (the only independent check here)", () => {
    const file = pngOf(W, H);
    expect(dimensionsOf(file)).toEqual({ width: W, height: H });

    // THE CHECK THAT IS NOT CIRCULAR. A fixture that writes 640×400 into the header and
    // a reader that reads 640×400 out of it have agreed about an offset, which is worth
    // something and is not proof the file is that size. A PNG's IDAT inflates to
    // exactly `height` rows of `1 + width` bytes for 8-bit greyscale, so counting them
    // derives both numbers from bytes the header does not contain.
    const length = (file[33]! << 24) | (file[34]! << 16) | (file[35]! << 8) | file[36]!;
    const idat = file.slice(41, 41 + length);
    expect(inflateSync(idat).length).toBe(H * (1 + W));
  });

  it("GIF — little-endian, which is the one of the four that is", () => {
    expect(dimensionsOf(gifOf(W, H))).toEqual({ width: W, height: H });
  });

  it("GIF87a as well as GIF89a", () => {
    const file = gifOf(W, H);
    file[4] = 0x37; // "9" -> "7"
    expect(dimensionsOf(file)).toEqual({ width: W, height: H });
  });

  it("JPEG — found by walking, past a segment that is not the frame header", () => {
    // The fixture carries a DQT between the APP0 and the SOF0 precisely so the walk has
    // something to skip. A reader that took the second marker it saw would answer with
    // a quantisation table's first two bytes.
    expect(dimensionsOf(jpegOf(W, H))).toEqual({ width: W, height: H });
  });

  it("JPEG — HEIGHT COMES FIRST in SOF0, which is the trap in this format", () => {
    const file = jpegOf(W, H);
    const found = dimensionsOf(file)!;
    expect(found.width).toBe(W);
    expect(found.height).toBe(H);
    expect(found.width).not.toBe(found.height);
  });

  it("WebP — 24-bit little-endian MINUS ONE, in VP8X", () => {
    // The one dimension field in these four formats that is not the number itself. A
    // reader that forgot the `+ 1` is off by one on every image and the error is
    // invisible at any size.
    expect(dimensionsOf(webpOf(W, H))).toEqual({ width: W, height: H });
  });

  it("answers null for a WebP chunk it does not know, rather than guessing", () => {
    const file = webpOf(W, H);
    file.set([0x56, 0x50, 0x39, 0x58], 12); // "VP9X"
    expect(dimensionsOf(file)).toBeNull();
  });

  it("answers null for a truncated header rather than reading past the end", () => {
    for (const build of [pngOf, gifOf, jpegOf, webpOf]) {
      const file = build(W, H);
      expect(dimensionsOf(file.slice(0, 6))).toBeNull();
    }
  });

  it("answers null for bytes that are no image at all", () => {
    expect(dimensionsOf(new TextEncoder().encode("this is not an image"))).toBeNull();
  });

  it("DOES NOT MISTAKE A WAV FOR A WEBP, and they share four bytes", () => {
    const wav = new Uint8Array(64);
    wav.set([...("RIFF" + "\0\0\0\0" + "WAVEfmt ")].map((c) => c.charCodeAt(0)));
    expect(dimensionsOf(wav)).toBeNull();
  });
});
