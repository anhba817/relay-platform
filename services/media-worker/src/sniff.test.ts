import { describe, expect, it } from "vitest";

import { AUDIO_VIDEO, gifOf, jpegOf, pngOf, webpOf } from "./fixtures.js";
import { sniff, typesAgree } from "./sniff.js";

// ALL TEN TYPES FR-MED-02 ALLOWS, and the six that are not images were named by no
// artifact in this feature until analysis pass 2. A type check covering four of ten
// passes every image test and lets every audio and video declaration through
// unverified.

describe("what the bytes say the file is", () => {
  it.each([
    ["image/png", pngOf(8, 8)],
    ["image/jpeg", jpegOf(8, 8)],
    ["image/gif", gifOf(8, 8)],
    ["image/webp", webpOf(8, 8)],
  ])("names %s from its magic number", (type, file) => {
    expect(sniff(file)).toBe(type);
  });

  it.each(AUDIO_VIDEO)("names %s from its magic number", (type, file) => {
    expect(sniff(file)).toBe(type);
  });

  it("tells a WAV from a WebP, which share their first four bytes", () => {
    const [, wav] = AUDIO_VIDEO.find(([t]) => t === "audio/wav")!;
    expect(sniff(wav)).toBe("audio/wav");
    expect(sniff(webpOf(8, 8))).toBe("image/webp");
  });

  it("reads an MP3 from a frame sync as well as from an ID3 tag", () => {
    // Both are legal starts and files in the wild use both. A reader that knew only
    // `ID3` would answer null for every stripped file, and null is not a rejection —
    // so the failure would be silent: the type check would simply never run.
    const tagged = AUDIO_VIDEO.filter(([t]) => t === "audio/mpeg");
    expect(tagged).toHaveLength(2);
    for (const [, file] of tagged) expect(sniff(file)).toBe("audio/mpeg");
  });

  it("answers null for bytes it does not recognise, which is not a rejection", () => {
    expect(sniff(new TextEncoder().encode("hello"))).toBeNull();
    expect(sniff(new Uint8Array(0))).toBeNull();
  });

  it("answers null for a Matroska file that is not WebM", () => {
    const mkv = new Uint8Array(64);
    mkv.set([0x1a, 0x45, 0xdf, 0xa3]);
    mkv.set([...("matroska")].map((c) => c.charCodeAt(0)), 10);
    expect(sniff(mkv)).toBeNull();
  });
});

describe("the MP4 pair, which one container cannot separate", () => {
  it("reads M4A's brand as audio and a generic brand as video", () => {
    const [, m4a] = AUDIO_VIDEO.find(([t]) => t === "audio/mp4")!;
    const [, mp4] = AUDIO_VIDEO.find(([t]) => t === "video/mp4")!;
    expect(sniff(m4a)).toBe("audio/mp4");
    expect(sniff(mp4)).toBe("video/mp4");
  });

  it("TREATS THE PAIR AS INTERCHANGEABLE, because the brand is not authoritative", () => {
    // `mp42`, `isom`, `avc1` and `iso5` are used for both, and the discriminator is the
    // `hdlr` inside `moov` — past a 64 KiB prefix on any file with `moov` at the end,
    // which is where most encoders put it. Without this, every correctly-declared
    // `audio/mp4` file in the platform would be rejected as a mismatch.
    expect(typesAgree("audio/mp4", "video/mp4")).toBe(true);
    expect(typesAgree("video/mp4", "audio/mp4")).toBe(true);
  });

  it("AND THE CAPS STILL HOLD, which is why the ambiguity is affordable", () => {
    // Declaring the audio kind and uploading a video buys the STRICTER cap — 25 MB
    // rather than 100 — so the pair cannot be used to smuggle a large file past
    // `KIND_CAPS`. The mistake it permits costs a label and no bytes.
    expect(typesAgree("audio/mp4", "image/png")).toBe(false);
    expect(typesAgree("video/mp4", "video/webm")).toBe(false);
  });

  it("lets nothing else through: every other disagreement is a mismatch", () => {
    expect(typesAgree("image/png", "image/jpeg")).toBe(false);
    expect(typesAgree("audio/wav", "image/webp")).toBe(false);
    expect(typesAgree("image/png", "image/png")).toBe(true);
  });
});
