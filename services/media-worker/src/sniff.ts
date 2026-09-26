// WHAT THE BYTES SAY THE FILE IS, AND THE STORE'S HEADER IS NOT EVIDENCE.
//
// MEASURED, NOT ASSUMED: a presigned PUT of twelve MP4 bytes sent with `content-type:
// image/png` answers `HEAD` with **`content-type: image/png`**. The store echoes the
// client's own claim, so a worker that compared `declared_bytes` against
// `content-length` and `mime_type` against `content-type` would have verified the
// declaration against itself. This file is the half that cannot be faked without
// producing a file of the type you claimed.
//
// TEN TYPES, BECAUSE FR-MED-02 ALLOWS TEN. The four image formats were the obvious
// half; the six audio and video ones were named by no artifact until analysis pass 2,
// and a type check that covered four of ten would have passed every image test and let
// every audio and video declaration through unverified.

/** The magic-number answer, or `null` when the bytes match nothing this knows.
 *
 * `null` IS NOT A REJECTION. FR-MED-02 already refused everything outside the ten at
 * slot time, so a prefix this cannot name is either truncated or a file the reader is
 * wrong about — and the caller decides which, because turning "I do not recognise this"
 * into "this is a lie" is how a verifier starts rejecting valid files. */
export function sniff(bytes: Uint8Array): string | null {
  const at = (i: number): number => bytes[i] ?? -1;
  const match = (sig: readonly number[], from = 0): boolean =>
    sig.every((v, i) => at(from + i) === v);
  const ascii = (s: string, from = 0): boolean =>
    match([...s].map((c) => c.charCodeAt(0)), from);

  if (match([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (match([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii("GIF87a") || ascii("GIF89a")) return "image/gif";
  if (ascii("RIFF") && ascii("WEBP", 8)) return "image/webp";
  // RIFF AGAIN, AND THAT IS THE POINT OF CHECKING BYTE 8. A WAV and a WebP share their
  // first four bytes; a reader that stopped at `RIFF` would call every WAV a WebP.
  if (ascii("RIFF") && ascii("WAVE", 8)) return "audio/wav";
  if (ascii("OggS")) return "audio/ogg";
  // EBML, shared by Matroska and WebM. The `DocType` element says which, and it is a
  // short walk into the header rather than a fixed offset — so this looks for the
  // literal, which the specification puts in the first 64 bytes of both.
  if (match([0x1a, 0x45, 0xdf, 0xa3])) {
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 64));
    return head.includes("webm") ? "video/webm" : null;
  }
  // MP3: either an ID3 tag or a frame sync. Both are legal starts and files in the
  // wild use both, so a reader that knew only `ID3` would fail on a stripped file.
  if (ascii("ID3")) return "audio/mpeg";
  if (at(0) === 0xff && (at(1) & 0xe0) === 0xe0) return "audio/mpeg";
  if (ascii("ftyp", 4)) return mp4(bytes);
  return null;
}

/** THE MP4 PAIR, DECIDED IN WRITING (`contracts/` §5b, T023b).
 *
 * `audio/mp4` and `video/mp4` are the SAME CONTAINER. Both declare `ftyp`, and the
 * authoritative discriminator is the track table inside `moov` — a walk through nested
 * boxes to find whether an `hdlr` says `vide` or `soun`, which is well past a 64 KiB
 * prefix on any file with the `moov` box at the end, where most encoders put it.
 *
 * THE BRAND SAYS SOMETHING AND NOT ENOUGH. `M4A ` and `M4B ` are audio-only brands and
 * are conclusive; `mp42`, `isom`, `avc1` and `iso5` are used for both. So this answers
 * `audio/mp4` for the two that are certain and `video/mp4` otherwise, and the caller
 * treats the pair as interchangeable rather than asserting a distinction the first
 * 64 KiB cannot make.
 *
 * AND THE CAPS STILL HOLD, which is the half worth stating. Declaring `audio/mp4` and
 * uploading a video buys the STRICTER cap — 25 MB rather than 100 — so the ambiguity
 * cannot be used to smuggle a large file past `KIND_CAPS`. The mistake it permits is
 * a video filed as audio, which costs a label and no bytes. */
function mp4(bytes: Uint8Array): string {
  const brand = new TextDecoder("latin1").decode(bytes.slice(8, 12));
  return brand === "M4A " || brand === "M4B " ? "audio/mp4" : "video/mp4";
}

/** THE PAIRS THAT MUST NOT COUNT AS A MISMATCH, and each one has a reason.
 *
 * A declaration is a lie when the bytes say something ELSE, not when the bytes say
 * something the reader cannot narrow. Without this table the MP4 ambiguity above would
 * reject every correctly-declared `audio/mp4` file in the platform. */
const INTERCHANGEABLE: ReadonlyArray<readonly [string, string]> = [
  // One container, and the discriminator is past the prefix (see `mp4`).
  ["audio/mp4", "video/mp4"],
];

export function typesAgree(declared: string, detected: string): boolean {
  if (declared === detected) return true;
  return INTERCHANGEABLE.some(
    ([a, b]) =>
      (declared === a && detected === b) || (declared === b && detected === a),
  );
}
