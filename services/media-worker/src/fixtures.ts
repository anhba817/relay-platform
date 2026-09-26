import { crc32, deflateSync } from "node:zlib";

// REAL FILES, BUILT HERE, AND THE CIRCULARITY IS NAMED RATHER THAN HIDDEN.
//
// A test that builds a header saying 640×480 and then asserts the reader answers
// 640×480 has proved that two pieces of code agree about an offset. That is worth
// something — it is what catches a reader using the wrong endianness or the wrong
// offset — and it is not proof that the file is a picture of that size.
//
// **PNG GETS AN INDEPENDENT CHECK AND THE OTHERS DO NOT.** A PNG's pixel data is a
// deflate stream of exactly `height` rows, each `1 + width * channels` bytes, so
// inflating the IDAT and counting is a second derivation of the same two numbers from
// bytes this file did not write into the header. `pngOf` builds real pixel data for
// that reason, and `png.test.ts` runs the check. GIF's LZW, JPEG's entropy-coded scan
// and WebP's VP8L bitstream each need a decoder to do the same, so their fixtures are
// valid headers whose dimension fields this module chose — the limit is stated in the
// tests that use them.
//
// AND THE CRCs ARE REAL. `crc32` over the IHDR chunk is computed, not copied, so a
// decoder outside this repository accepts the result.

const u32 = (n: number): Uint8Array =>
  new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

const bytes = (...parts: Array<Uint8Array | number[]>): Uint8Array => {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
};

const ascii = (s: string): Uint8Array =>
  new Uint8Array([...s].map((c) => c.charCodeAt(0)));

function chunk(type: string, body: Uint8Array): Uint8Array {
  const typed = bytes(ascii(type), body);
  return bytes(u32(body.length), typed, u32(crc32(typed) >>> 0));
}

/** A real PNG of the given size: 8-bit greyscale, one filter byte a row, deflated. */
export function pngOf(width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width)] = 0; // filter type 0
    for (let x = 0; x < width; x += 1) raw[y * (1 + width) + 1 + x] = (x + y) & 255;
  }
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk("IHDR", bytes(u32(width), u32(height), [8, 0, 0, 0, 0])),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  );
}

const u16le = (n: number): number[] => [n & 255, (n >> 8) & 255];

/** GIF89a: signature, logical screen descriptor, a one-colour table, an image
 * descriptor that repeats the size, and a minimal LZW block. */
export function gifOf(width: number, height: number): Uint8Array {
  return bytes(
    ascii("GIF89a"),
    u16le(width),
    u16le(height),
    [0xf0, 0x00, 0x00],
    [0x00, 0x00, 0x00, 0xff, 0xff, 0xff],
    [0x2c],
    u16le(0),
    u16le(0),
    u16le(width),
    u16le(height),
    [0x00],
    [0x02, 0x02, 0x44, 0x01, 0x00],
    [0x3b],
  );
}

/** Baseline JPEG: SOI, JFIF APP0, a quantisation table, SOF0 carrying the size, and
 * EOI. No scan — the reader stops at the frame header, and a file with a scan would
 * make the fixture a hundred times larger for nothing this reads. */
export function jpegOf(width: number, height: number): Uint8Array {
  const u16be = (n: number): number[] => [(n >> 8) & 255, n & 255];
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe0],
    u16be(16),
    ascii("JFIF"),
    [0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00],
    // A DQT, so the reader has a real segment to SKIP before reaching the frame —
    // which is the half of the walk a two-segment file would not exercise.
    [0xff, 0xdb],
    u16be(67),
    [0x00],
    new Uint8Array(64).fill(16),
    [0xff, 0xc0],
    u16be(11),
    [0x08],
    u16be(height),
    u16be(width),
    [0x01, 0x01, 0x11, 0x00],
    [0xff, 0xd9],
  );
}

/** WebP, extended form (`VP8X`), whose canvas size is 24-bit little-endian MINUS ONE —
 * the one dimension field in these four formats that is not the number itself. */
export function webpOf(width: number, height: number): Uint8Array {
  const u24le = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  const body = bytes(
    ascii("WEBP"),
    ascii("VP8X"),
    [10, 0, 0, 0],
    [0x10, 0, 0, 0],
    u24le(width - 1),
    u24le(height - 1),
  );
  return bytes(ascii("RIFF"), new Uint8Array(u32le(body.length)), body);
}

function u32le(n: number): number[] {
  return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
}

/** The six audio and video types, as the shortest prefix that identifies each. Nothing
 * reads their dimensions, so these carry a header and no payload. */
export const AUDIO_VIDEO: ReadonlyArray<readonly [string, Uint8Array]> = [
  ["audio/mpeg", bytes(ascii("ID3"), [3, 0, 0, 0, 0, 0, 0])],
  ["audio/mpeg", bytes([0xff, 0xfb, 0x90, 0x00])],
  ["audio/ogg", bytes(ascii("OggS"), [0, 2, 0, 0, 0, 0, 0, 0])],
  [
    "audio/wav",
    bytes(ascii("RIFF"), new Uint8Array(u32le(36)), ascii("WAVEfmt ")),
  ],
  [
    "audio/mp4",
    bytes([0, 0, 0, 0x18], ascii("ftyp"), ascii("M4A "), [0, 0, 2, 0]),
  ],
  [
    "video/mp4",
    bytes([0, 0, 0, 0x18], ascii("ftyp"), ascii("isom"), [0, 0, 2, 0]),
  ],
  [
    "video/webm",
    bytes(
      [0x1a, 0x45, 0xdf, 0xa3],
      [0x9f, 0x42, 0x86, 0x81, 0x01],
      [0x42, 0x82, 0x84],
      ascii("webm"),
    ),
  ],
];
