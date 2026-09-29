import sharp from "sharp";

import { RENDITION_FAILED, type RenditionFailure } from "@relay/protocol";

// FR-MED-05's image half. The video half is not built — ADR-34 and SRS 1.22 carry the
// reason and the reversal condition, and the short version is that a poster frame needs a
// video decoder where a thumbnail needs an image one: ffmpeg measured 113,994,336 B
// against this dependency's 30,380,799 B, for the harder half of a clause whose easier
// half (duration) chapter 4.13 already declined.

/** The long edge, in pixels. **MEASURED, NOT CHOSEN.** `research.md` R2 resized one
 * series at a 320 px bound and the ratio turns exactly here:
 *
 *     parent 320x320   thumbnail 66,544 B   97.4% of the parent
 *     parent 400x400   thumbnail 58,226 B   54.8%
 *     parent 640x480   thumbnail 35,178 B   17.2%
 *     parent 1920x1080 thumbnail 13,258 B    1.0%
 *
 * Below the bound the "thumbnail" is the same pixels in a different container, so a
 * tenant stores the image twice to save 2.6%. That is why `within-bound` is an outcome
 * rather than a smaller output. */
export const THUMBNAIL_BOUND = 320;

export type ThumbnailOutcome =
  | { kind: "made"; bytes: Uint8Array; width: number; height: number }
  | { kind: "within-bound" }
  | { kind: "failed"; reason: RenditionFailure };

/** WHICH TYPES GET A RENDITION, ASKED OF THE DECODER RATHER THAN LISTED.
 *
 * FR-007 requires this to be derived, and a hand-written list would be a second
 * allow-list to keep in step with `ALLOWED_TYPES` — which this service cannot even
 * import, because it lives in the api. That is not a gap: the api refuses every type
 * outside its allow-list at the slot route, so **the intersection happens upstream** and
 * the only question left here is whether this decoder can read the bytes.
 *
 * `sharp.format` reports what libvips was built with, so the answer moves if the binary
 * does — which is the point of asking rather than declaring. */
export function decodableTypes(): ReadonlySet<string> {
  return new Set(
    Object.entries(sharp.format)
      .filter(([, support]) => support.input?.buffer)
      .map(([name]) => `image/${name}`),
  );
}

/** Whether a rendition is worth attempting for a type the PROBE detected.
 *
 * THE SNIFFED TYPE, NEVER THE DECLARED ONE. 4.13 measured a presigned PUT of twelve MP4
 * bytes sent as `content-type: image/png` answering `HEAD` with `image/png` — the store
 * echoes the client's own claim, so `content-type` is not evidence. `sniff()` reads the
 * bytes. */
export function canThumbnail(detectedType: string | null): boolean {
  return detectedType !== null && decodableTypes().has(detectedType);
}

/** Turn an image into a bounded WebP, or say why not.
 *
 * WEBP BECAUSE THE OUTPUT FORMAT IS OURS TO CHOOSE and it is the smallest of the four at
 * this size. The input format is the client's and is whatever it is.
 *
 * `withoutEnlargement` MATTERS FOR CORRECTNESS, NOT TIDINESS. Without it a 100x80 avatar
 * becomes a 320x256 upscale — bigger than the original, blurrier than the original, and
 * charged to the tenant's quota. With it, an image already inside the bound comes back
 * the same size, which is the case `within-bound` refuses to write at all. */
export async function thumbnailOf(bytes: Uint8Array): Promise<ThumbnailOutcome> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await sharp(bytes).metadata());
  } catch {
    // The probe said this was an image and the decoder disagrees. A truncated upload, a
    // format libvips was not built with, or bytes that only look like a header — all one
    // answer, because none of them is recoverable by trying again.
    return { kind: "failed", reason: "decode_failed" };
  }
  if (width === undefined || height === undefined) {
    return { kind: "failed", reason: "decode_failed" };
  }
  if (width <= THUMBNAIL_BOUND && height <= THUMBNAIL_BOUND) {
    return { kind: "within-bound" };
  }
  try {
    const out = await sharp(bytes)
      .resize(THUMBNAIL_BOUND, THUMBNAIL_BOUND, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return {
      kind: "made",
      bytes: out.data,
      width: out.info.width,
      height: out.info.height,
    };
  } catch {
    return { kind: "failed", reason: "decode_failed" };
  }
}

/** Kept honest by the compiler: every reason this module can produce is in the protocol
 * package's closed set. `store_write_failed` is the caller's to produce, not this
 * module's — it never touches the store. */
const _reasonsAreClosed: readonly RenditionFailure[] = RENDITION_FAILED;
void _reasonsAreClosed;
