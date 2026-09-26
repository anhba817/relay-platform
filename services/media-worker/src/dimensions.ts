// WHAT THE FIRST 64 KIB SAY ABOUT AN IMAGE, AND NO DEPENDENCY.
//
// ADR-30's precedent: SigV4 is twenty-eight lines of `node:crypto` rather than two AWS
// packages, on the ratio between what the platform needs and what the library carries.
// The same ratio holds here. `sharp` is a native binary with a 10 MB install and an
// image-processing surface this platform never uses; `image-size` is small and correct
// and is still a dependency for four fixed offsets.
//
// AND THE REASON IT IS FOUR FIXED OFFSETS IS MEASURED. A PNG's dimensions are 24 bytes
// of a 4,722-byte file — 0.51% — and GIF's are bytes 6 to 10. JPEG needs a walk over
// segment headers to the first `SOF` marker, and WebP's sit in the first chunk after
// the RIFF header. None of the four decodes a pixel.
//
// DURATION IS THE HALF THAT IS NOT HERE. Four unrelated container parsers with MP3 VBR
// as a genuinely hard case, which is why FR-MED-04 is recorded PARTLY MET on FR-MED-07's
// SRS 1.18 precedent rather than pretended.

export interface Dimensions {
  width: number;
  height: number;
}

/** `null` MEANS THE BYTES DO NOT SAY, which is different from "the file is broken".
 * A truncated header, a format with no dimensions, or a prefix that stopped before the
 * `SOF` marker all answer the same way — and the caller records the absence rather than
 * a zero, because a `width` of 0 is a claim about an image that is 0 pixels wide. */
/** The largest side this will report.
 *
 * NOT A FORMAT LIMIT — PNG's own is 2^31 - 1 — BUT A PLAUSIBILITY ONE. This reader sees
 * at most the first 64 KiB, so a header saying 4,278,190,090 pixels wide is a header it
 * has no way to check; the largest real photograph is three orders of magnitude under
 * this. Above it the answer is `null`, which means *the bytes do not say* and is exactly
 * what a header the reader cannot believe amounts to.
 *
 * AND IT IS A REFUSAL, NOT A CLAMP. Recording 1,000,000 for an image that claims four
 * billion would be a number this platform made up. */
export const MAX_DIMENSION = 1_000_000;

export function dimensionsOf(bytes: Uint8Array): Dimensions | null {
  const found = png(bytes) ?? gif(bytes) ?? webp(bytes) ?? jpeg(bytes);
  if (found === null) return null;
  const plausible = (n: number): boolean =>
    Number.isInteger(n) && n > 0 && n <= MAX_DIMENSION;
  return plausible(found.width) && plausible(found.height) ? found : null;
}

// `>>> 0`, AND IT IS NOT DEFENSIVENESS — IT WAS MEASURED. JavaScript's `<<` is a SIGNED
// 32-bit operation, so a PNG whose width has the high bit set reads NEGATIVE: bytes
// `ff 00 00 0a` give **-16777206** without the shift and 4278190090 with it. The verdict
// route's schema says `z.number().int().positive()`, so the api answered **400** and the
// worker retried the same object every sweep forever — found by running the sweep
// against random bytes behind a PNG signature, which no unit test would have produced.
const u32be = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u16be = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);

const starts = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** `IHDR` IS ALWAYS THE FIRST CHUNK, which the specification requires — so width and
 * height are at fixed offsets 16 and 20 and there is nothing to walk. */
function png(b: Uint8Array): Dimensions | null {
  if (!starts(b, PNG_SIG) || b.length < 24) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** GIF's logical screen descriptor follows the six-byte signature, LITTLE-endian —
 * the one of the four that is, and the reason `u16le` exists in this file. */
function gif(b: Uint8Array): Dimensions | null {
  const sig = starts(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    starts(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  if (!sig || b.length < 10) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

/** THREE WEBPs, NOT ONE. `VP8 ` (lossy), `VP8L` (lossless) and `VP8X` (extended) store
 * their size differently, and a reader that knows only the first returns nothing for a
 * lossless file — which is the per-format red T024 asks for, in one format. */
function webp(b: Uint8Array): Dimensions | null {
  if (!starts(b, [0x52, 0x49, 0x46, 0x46]) || !starts(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return null;
  }
  const chunk = String.fromCharCode(...b.slice(12, 16));
  if (chunk === "VP8X" && b.length >= 30) {
    // 24-bit little-endian, minus one.
    const w = b[24]! | (b[25]! << 8) | (b[26]! << 16);
    const h = b[27]! | (b[28]! << 8) | (b[29]! << 16);
    return { width: w + 1, height: h + 1 };
  }
  if (chunk === "VP8 " && b.length >= 30) {
    // The keyframe header: a three-byte start code at 23, then 14-bit dimensions.
    return {
      width: u16le(b, 26) & 0x3fff,
      height: u16le(b, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && b.length >= 25) {
    // 14 bits each, packed across four bytes after the one-byte signature.
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

/** THE ONLY ONE THAT WALKS. JPEG is a sequence of marker segments and the dimensions
 * live in whichever `SOF` marker the encoder used — there are thirteen of them and they
 * are not contiguous, so the exclusions matter as much as the range. */
function jpeg(b: Uint8Array): Dimensions | null {
  if (!starts(b, [0xff, 0xd8])) return null;
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = b[at + 1]!;
    // `SOF0`–`SOF15`, minus `DHT` (0xc4), `JPG` (0xc8) and `DAC` (0xcc), which sit
    // inside the range and are not frame headers. A reader that took the whole range
    // would read a Huffman table's first bytes as a picture's size.
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) return { height: u16be(b, at + 5), width: u16be(b, at + 7) };
    // Standalone markers carry no length: skipping two bytes past them is the only
    // correct move, and reading a length where there is none walks off into the data.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}
