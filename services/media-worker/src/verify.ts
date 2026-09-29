import type { InternalMediaVerdictRequest } from "@relay/protocol";

import { dimensionsOf } from "./dimensions.js";
import { sniff, typesAgree } from "./sniff.js";
import { scan, type ScannerConfig } from "./scan.js";
import {
  getRange,
  headObject,
  streamObject,
  type StoreConfig,
} from "./store.js";

// ONE OBJECT'S VERDICT.
//
// THE ORDER IS SCAN, SIZE, TYPE, AND STATING IT TOOK FIVE ANALYSIS PASSES. Each earlier
// fix was pairwise — the size comparison moved onto the sweep's `HEAD`, and the scan
// moved ahead of the *type* check so EICAR could reach it — which left the size verdict
// knowable before the scan and nothing saying whether it short-circuits.
//
// **IT DOES NOT.** The scan runs on every object that has bytes, whatever the
// declaration says, because FR-MED-04 is *"every uploaded object shall be
// virus-scanned"* — and an object declaring one byte while holding five megabytes is at
// least as worth scanning as one whose type is wrong. Reading the clause one way and not
// the other would be reading it selectively.
//
// WHAT THE ORDER IS FOR. FR-MED-04 says *"every uploaded object shall be
// virus-scanned"*, so the type check cannot short-circuit it — an object declaring one
// byte while holding five megabytes is at least as worth scanning as one whose type is
// wrong, and reading the clause one way and not the other would be reading it
// selectively. The size answer is KNOWN from the `HEAD` the sweep already makes and is
// ACTED ON after the scan. Stating that took five analysis passes: each earlier fix was
// pairwise and left the order between them unsaid.
//
// THE COST IS STREAMING UP TO 100 MB FOR AN OBJECT THAT WILL BE REFUSED — and a caller
// who wants 100 MB streamed can upload a valid 100 MB video, so the worst case is the
// cap either way.

/** How much of the object the type and dimension probes see.
 *
 * 64 KIB, AND THE FIGURE IS NOT ARBITRARY. A PNG's dimensions are 24 bytes of 4,722 —
 * 0.51% — and GIF's are ten. JPEG is the one that walks, and a JPEG whose first `SOF`
 * marker is past 64 KiB has an EXIF block larger than most whole images; the reader
 * answers `null` there and the chapter records the bound rather than fetching 100 MB
 * to cover it. */
export const PROBE_BYTES = 64 * 1024;

export interface Probe {
  /** The store's own count, which is the only trustworthy number in the exchange. */
  bytes: number;
  /** What the BYTES say, not what the store's `content-type` header says. */
  detectedType: string | null;
  width?: number;
  height?: number;
  /** SC-006's start instant, at one-second resolution — an HTTP date has no
   * sub-second field, and the exactness the spec's client-notice design would have
   * given is a real cost of `research.md` R1's decision. */
  uploadedAt: Date | null;
  /** The signature the scanner named, when it named one. Present means `scan_failed`
   * and the type and dimension probes were never run — there is nothing to learn from
   * the shape of a file that is being destroyed. */
  infected?: string;
}

export interface PendingObject {
  id: string;
  object_key: string;
  /** The tenant, so a rendition's key can be written in the platform's own
   * `${environment_id}/${id}` layout rather than derived from the parent's (4.15).
   *
   * AND THIS INTERFACE IS A SECOND COPY OF `internalMediaPendingItemSchema`, which is
   * how adding one field cost two edits. It predates the shape being on the wire at all
   * and is narrower on purpose — the worker uses four of the five fields. Worth folding
   * into the protocol type the next time either changes for another reason; not worth a
   * refactor in a chapter about thumbnails. */
  environment_id: string;
  mime_type: string;
  declared_bytes: number;
}

/** Read what the store holds, or `null` if it holds nothing yet.
 *
 * TWO ROUND TRIPS, NOT ONE, AND MEASURING THAT IS T027. The `HEAD` answers size and
 * `last-modified`; the ranged `GET` answers type and dimensions. They could be one
 * request — a `Range: bytes=0-65535` GET carries `content-range`, which gives the total
 * size too — and they are two because the `HEAD` is what decides whether the object
 * exists at all, and 91.6% of the lane's rows do not. **Collapsing them would fetch
 * 64 KiB for every object that holds nothing**, which is the majority case. */
export async function probe(
  object: PendingObject,
  store: StoreConfig,
  scanner?: ScannerConfig,
): Promise<Probe | null> {
  const head = await headObject(store, object.object_key);
  if (head === null) return null;

  // THE SCAN FIRST, AND UNCONDITIONALLY. Nothing above it can refuse the object, so
  // there is no path on which an uploaded object reaches a verdict unscanned.
  if (scanner) {
    const bytes = await streamObject(store, object.object_key);
    // The object vanished between the `HEAD` and the `GET` — FR-MED-10's reap, or a
    // tenant deleted. No verdict, and the next sweep will find the row gone.
    if (bytes === null) return null;
    const result = await scan(scanner, bytes);
    // A SCANNER THAT COULD NOT ANSWER PRODUCES NO VERDICT AT ALL (FR-009). Not
    // `rejected`, which would destroy a customer's bytes on the strength of an outage;
    // not `ready`, which would let an unscanned object through. The object stays
    // `pending` and the next sweep finds it.
    if (result.outcome === "unavailable") return null;
    if (result.outcome === "infected") {
      return {
        bytes: head.bytes,
        detectedType: null,
        uploadedAt: head.lastModified,
        infected: result.signature,
      };
    }
  }

  const prefix = await getRange(store, object.object_key, PROBE_BYTES);
  const detectedType = prefix ? sniff(prefix) : null;
  const size = prefix ? dimensionsOf(prefix) : null;

  return {
    bytes: head.bytes,
    detectedType,
    ...(size ? { width: size.width, height: size.height } : {}),
    uploadedAt: head.lastModified,
  };
}

/** The declaration, judged against the probe.
 *
 * TWO WAYS TO BE A LIE AND ONE WAY TO BE UNKNOWN. A size that disagrees and a type
 * that disagrees are both `declaration_mismatch` — FR-005 wants the platform to
 * distinguish a mismatch from a scan failure, and it does not ask the platform to
 * distinguish the two kinds of mismatch, because the customer sees neither.
 *
 * AND A TYPE THE READER CANNOT NAME IS NOT A MISMATCH. `sniff` returns `null` for a
 * prefix it does not recognise, and turning that into a rejection would refuse valid
 * files for the reader's ignorance. FR-MED-02 already refused everything outside the
 * ten allowed types at slot time. */
export function judge(
  object: PendingObject,
  found: Probe,
): InternalMediaVerdictRequest {
  const rejected = (): InternalMediaVerdictRequest => ({
    verdict: "rejected",
    reason: "declaration_mismatch",
    verified_bytes: found.bytes,
    ...(found.detectedType ? { verified_type: found.detectedType } : {}),
  });

  // SCAN FIRST, AND IT WINS (T039b). An object can fail both, and `scan_failed` is the
  // more serious fact about the caller — it is what an operator reading
  // `rejected_reason` needs, and a mis-declared infected file filed as
  // `declaration_mismatch` would be a count that understates the thing being counted.
  if (found.infected !== undefined) {
    return {
      verdict: "rejected",
      reason: "scan_failed",
      verified_bytes: found.bytes,
    };
  }

  if (found.bytes !== object.declared_bytes) return rejected();
  if (found.detectedType && !typesAgree(object.mime_type, found.detectedType)) {
    return rejected();
  }

  return {
    verdict: "ready",
    verified_bytes: found.bytes,
    // WHAT THE BYTES SAID, falling back to the declaration only when the reader could
    // not name the prefix. Recording the declaration as `verified_type` for a file the
    // worker could not identify would be a column claiming a verification that did not
    // happen — and the fallback is visible here rather than hidden in the reader.
    verified_type: found.detectedType ?? object.mime_type,
    ...(found.width !== undefined ? { width: found.width } : {}),
    ...(found.height !== undefined ? { height: found.height } : {}),
  };
}
