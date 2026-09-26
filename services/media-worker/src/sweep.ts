import type { InternalMediaVerdictRequest } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import {
  ApiError,
  VerdictRefusedError,
  type ApiClient,
} from "./api-client.js";
import { bucketPresent, headObject, type StoreConfig } from "./store.js";

// ONE PASS OVER THE BACKLOG.
//
// A SWEEP RATHER THAN AN EVENT, WHICH IS research R1 DECIDED AGAINST THE SPECIFICATION.
// The spec assumed the client tells us the upload finished; there is no such notice and
// no producer for one — `media.uploaded` occurs nowhere in this repository, because the
// client PUTs straight to the store and the only two parties that know are the client
// and the store. The spec rejected a sweep on *"91.6% of the work spent on objects that
// hold nothing"*, and the waste is free: one signed `HEAD` is 1.412 ms and the lane's
// whole backlog is 4.2 s serial. **FR-MED-04's "every uploaded object shall be
// virus-scanned" cannot be contingent on a client choosing to send a notice**, so the
// sweep is the mechanism and any notice is an optimisation that must not change an
// answer.

export interface SweepDeps {
  api: ApiClient;
  store: StoreConfig;
  logger: Logger;
  /** How many objects one pass asks for. The api caps it at 200. */
  batch?: number;
  /** Injected so a test can drive the probe without a scanner. Phase 5 replaces the
   * default with one that streams the bytes through ClamAV. */
  verify?: Verify;
  /** Injected for the same reason. The default is the real signed `HEAD` against the
   * bucket; a unit test has no store and the point of this dependency is the BRANCH it
   * guards, which is the one that produces silence. */
  probeBucket?: (store: StoreConfig) => Promise<boolean>;
}

/** What a single object's verification decides.
 *
 * SEPARATE FROM THE LOOP ON PURPOSE. The loop is about ordering, refusals and what to
 * do when the store is unreachable; this is about one object's bytes. Phases 3 and 5
 * extend this function and leave the loop alone. */
export type Verify = (
  object: {
    id: string;
    object_key: string;
    mime_type: string;
    declared_bytes: number;
  },
  store: StoreConfig,
) => Promise<InternalMediaVerdictRequest | null>;

/** `null` MEANS NO VERDICT, WHICH IS NOT THE SAME AS A BAD ONE. The object is not in
 * the store yet, or the store could not be reached — either way the row stays `pending`
 * and the next sweep finds it. There is no `retry` verdict, because a row recording
 * *"we could not tell"* is one somebody later reads as a fact. */
export const verifyDeclaration: Verify = async (object, store) => {
  const head = await headObject(store, object.object_key);
  if (head === null) return null;

  // THE SIZE HALF OF FR-MED-03, AND THE STORE'S NUMBER IS THE TRUE ONE.
  // `content-length` is what the store will serve; `declared_bytes` is what the client
  // said before uploading anything. The `content-type` beside it is the client's own
  // claim echoed back and is not evidence — which is why the type half needs the bytes
  // (phase 3) and cannot be answered here.
  if (head.bytes !== object.declared_bytes) {
    return {
      verdict: "rejected",
      reason: "declaration_mismatch",
      verified_bytes: head.bytes,
    };
  }

  return {
    verdict: "ready",
    verified_bytes: head.bytes,
    verified_type: object.mime_type,
  };
};

export interface SweepResult {
  seen: number;
  ready: number;
  rejected: number;
  /** Objects with no bytes in the store yet. The commonest outcome by far, and the one
   * the spec's rejected cost argument was about. */
  waiting: number;
  /** Set when the store has no bucket, in which case nothing was examined and every
   * object would have read as `waiting`. */
  storeUnavailable?: true;
}

export async function sweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const { api, store, logger } = deps;
  const verify = deps.verify ?? verifyDeclaration;
  const result: SweepResult = { seen: 0, ready: 0, rejected: 0, waiting: 0 };

  // THE BUCKET FIRST, BECAUSE A 404 IS AMBIGUOUS AND THE SWEEP CANNOT SEE IT.
  // Without this the worker is inert and silent against a store that has no bucket:
  // every object answers 404, every 404 reads as "not yet", and the log says nothing.
  if (!(await (deps.probeBucket ?? bucketPresent)(store))) {
    logger.log("error", "the object store has no bucket; nothing can be verified");
    return { ...result, storeUnavailable: true };
  }

  const objects = await api.pending(deps.batch ?? 50);
  result.seen = objects.length;

  for (const object of objects) {
    let decision: InternalMediaVerdictRequest | null;
    try {
      decision = await verify(object, store);
    } catch (error) {
      // A TRANSIENT FAILURE SENDS NOTHING. The row stays `pending` and the next sweep
      // finds it — FR-009 as an absence rather than a value.
      logger.log("error", "could not verify object", {
        media_id: object.id,
        error: error instanceof Error ? error.message : String(error),
      });
      result.waiting += 1;
      continue;
    }

    if (decision === null) {
      result.waiting += 1;
      continue;
    }

    try {
      const answer = await api.verdict(object.id, decision);
      if (answer === null) {
        logger.log("info", "object vanished before its verdict landed", {
          media_id: object.id,
        });
        continue;
      }
      if (decision.verdict === "ready") result.ready += 1;
      else result.rejected += 1;
    } catch (error) {
      if (error instanceof VerdictRefusedError) {
        // Somebody else rejected it while this sweep held it. Not a failure of this
        // process and not worth retrying: the bytes are already gone.
        logger.log("info", "verdict refused; the object was already rejected", {
          media_id: object.id,
        });
        continue;
      }
      if (error instanceof ApiError) {
        logger.log("error", "the api refused a verdict", {
          media_id: object.id,
          status: error.status,
        });
        continue;
      }
      throw error;
    }
  }

  return result;
}
