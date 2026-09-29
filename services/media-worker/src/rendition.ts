import { randomUUID } from "node:crypto";

import type { InternalMediaVerdictRequest } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import { getObject, putObject, type StoreConfig } from "./store.js";
import { canThumbnail, THUMBNAIL_BOUND, thumbnailOf } from "./thumbnail.js";
import type { Probe } from "./verify.js";

/** The image cap FR-MED-02 enforces at slot time, repeated here as a ceiling on what
 * this process will hold in memory. It is not a second policy: an object above it
 * cannot have been admitted, so meeting one means the row and the store disagree. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Attach a rendition to a `ready` verdict, or leave the verdict alone.
 *
 * **THE FETCH IS THE COST THIS CHAPTER IS NAMED AFTER, AND IT IS A FOURTH ROUND TRIP.**
 * The worker holds no object: `headObject` takes metadata, `streamObject` hands ClamAV an
 * iterable consumed once at 64 KiB a chunk, and `getRange` takes a 64 KiB prefix. So
 * bytes to resize have to be fetched, and `research.md` R9 chose that over the two
 * alternatives — teeing the scan buffers every object including the 100 MB video cap, and
 * one buffered GET up front does it before anything knows the object is an image.
 *
 * **THREE STATES, NOT TWO, AND THE THIRD IS AN ORDINARY CAMERA JPEG.** Measured: a JPEG
 * carrying one maximal APP1 segment — 72,215 B, which is what EXIF plus an embedded
 * preview looks like — returns no dimensions from the 64 KiB probe, while the same bytes
 * read whole decode as 1200x900. A gate with two states would have denied renditions to
 * exactly the files most likely to want one, so unknown dimensions FETCH and let the
 * decoder answer.
 *
 *     image, dimensions known, above the bound   ->  fetch
 *     image, dimensions known, within the bound  ->  no fetch, no rendition
 *     image, dimensions UNKNOWN                  ->  fetch, decide from the decoded size
 *
 * **A FAILURE HERE NEVER STOPS THE PARENT REACHING `ready` (FR-008).** The sweep re-reads
 * `pending` rows for ever, so an object left `pending` because its thumbnail failed is an
 * infinite retry wearing a state's clothes. It goes `ready` with a recorded reason. */
export async function withRendition(
  decision: InternalMediaVerdictRequest,
  object: { id: string; environment_id: string; object_key: string },
  found: Probe,
  store: StoreConfig,
  logger?: Logger,
): Promise<InternalMediaVerdictRequest> {
  if (decision.verdict !== "ready") return decision;

  // THE SNIFFED TYPE, NEVER THE DECLARED ONE (4.13): a presigned PUT of twelve MP4 bytes
  // sent as `image/png` answers `HEAD` with `image/png`, because the store echoes the
  // client's own claim. Audio and video reach here and leave with no rendition and no
  // reason, which is not a failure — FR-MED-05 asks for thumbnails of images.
  if (!canThumbnail(found.detectedType)) return decision;

  const dimensionsKnown = found.width !== undefined && found.height !== undefined;
  if (
    dimensionsKnown &&
    found.width! <= THUMBNAIL_BOUND &&
    found.height! <= THUMBNAIL_BOUND
  ) {
    // R2's crossover, and the saving is the whole round trip: at or below the bound the
    // output is 97.3% of the parent and the same pixels.
    return decision;
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await getObject(store, object.object_key, MAX_IMAGE_BYTES);
  } catch (error) {
    logger?.log("error", "could not fetch an object to render", {
      media_id: object.id,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ...decision, rendition_failed_reason: "store_write_failed" };
  }
  // The object went between the scan and this fetch — FR-MED-10's reap, or a tenant
  // deleted. The verdict still stands: it was true when the bytes were read.
  if (bytes === null) return decision;

  const outcome = await thumbnailOf(bytes);
  if (outcome.kind === "within-bound") return decision;
  if (outcome.kind === "failed") {
    logger?.log("info", "no rendition for an object that passed verification", {
      media_id: object.id,
      reason: outcome.reason,
    });
    return { ...decision, rendition_failed_reason: outcome.reason };
  }

  // THE KEY IS THE PLATFORM'S OWN LAYOUT — `${environment_id}/${id}`, the same shape
  // `media.service.ts:108` gives an upload — and NOT the parent's key with a suffix.
  // `schema.ts` says `object_key` is *"OPAQUE, AND NOT A PATH INTO THE STORE … keeping
  // them separate is what lets the storage layout change without breaking a published
  // contract"*, and a derived key would couple two rows' addresses.
  const id = randomUUID();
  const objectKey = `${object.environment_id}/${id}`;
  const written = await putObject(store, objectKey, outcome.bytes, "image/webp");
  if (!written) {
    logger?.log("error", "a rendition could not be written to the store", {
      media_id: object.id,
      object_key: objectKey,
    });
    return { ...decision, rendition_failed_reason: "store_write_failed" };
  }

  // BYTES FIRST, ROW SECOND, AND THE ORDER IS THE CHEAPER FAILURE. A verdict that never
  // lands leaves an object in the store with no row — which FR-MED-10's reap collects.
  // The other order leaves a row pointing at nothing, and no reaper can invent bytes.
  return {
    ...decision,
    rendition: {
      id,
      kind: "thumbnail",
      object_key: objectKey,
      bytes: outcome.bytes.length,
      width: outcome.width,
      height: outcome.height,
    },
  };
}
