import type { InternalMediaVerdictRequest } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import {
  ApiError,
  VerdictRefusedError,
  type ApiClient,
} from "./api-client.js";
import { bucketPresent, type StoreConfig } from "./store.js";
import type { ScannerConfig } from "./scan.js";
import { withRendition } from "./rendition.js";
import { judge, probe, type PendingObject } from "./verify.js";

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
  /** How many objects one PAGE asks for. The api caps it at 200. */
  batch?: number;
  /** How many pages one sweep will walk before giving up until the next interval. */
  maxPages?: number;
  /** Injected so a test can drive the probe without a scanner. Phase 5 replaces the
   * default with one that streams the bytes through ClamAV. */
  verify?: Verify;
  /** Injected for the same reason. The default is the real signed `HEAD` against the
   * bucket; a unit test has no store and the point of this dependency is the BRANCH it
   * guards, which is the one that produces silence. */
  probeBucket?: (store: StoreConfig) => Promise<boolean>;
  /** WHERE THE SCANNER IS, AND ITS ABSENCE IS NOT "SKIP THE SCAN" AT RUNTIME. `main.ts`
   * always supplies one; a suite about dimensions omits it so the test needs no
   * scanner, and `scan.itest.ts` is what covers the arm that has one. */
  scanner?: ScannerConfig;
}

/** What a single object's verification decides.
 *
 * SEPARATE FROM THE LOOP ON PURPOSE. The loop is about ordering, refusals and what to
 * do when the store is unreachable; this is about one object's bytes. Phases 3 and 5
 * extend this function and leave the loop alone. */
export type Verify = (
  object: PendingObject,
  store: StoreConfig,
) => Promise<InternalMediaVerdictRequest | null>;

/** `null` MEANS NO VERDICT, WHICH IS NOT THE SAME AS A BAD ONE. The object is not in
 * the store yet, or the store could not be reached — either way the row stays `pending`
 * and the next sweep finds it. There is no `retry` verdict, because a row recording
 * *"we could not tell"* is one somebody later reads as a fact. */
export const verifyObject =
  (scanner?: ScannerConfig): Verify =>
  async (object, store) => {
    const found = await probe(object, store, scanner);
    if (found === null) return null;
    // FR-MED-05 (4.15). `judge` stays a pure function over the probe — the rendition
    // needs three round trips and cannot live in it, which is why this seam grew rather
    // than that one. A `rejected` verdict passes straight through: FR-009 wants no
    // derived bytes for a refused object, and never writing them is cheaper than a
    // cleanup path that has to be correct.
    return withRendition(judge(object, found), object, found, store);
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

/** Objects whose verdict the api refused with a 4xx this process cannot fix.
 *
 * PROCESS-LOCAL AND UNBOUNDED, WHICH IS STATED RATHER THAN HIDDEN. Each entry is a UUID
 * string — about 100 bytes — so a worker would need a hundred thousand such objects to
 * cost 10 MB, and a hundred thousand of them means the deploy is broken rather than the
 * set. It is exported so a test can clear it; nothing in production does. */
export const refusedByTheApi = new Set<string>();

export async function sweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const { api, store, logger } = deps;
  const verify = deps.verify ?? verifyObject(deps.scanner);
  const result: SweepResult = { seen: 0, ready: 0, rejected: 0, waiting: 0 };

  // THE BUCKET FIRST, BECAUSE A 404 IS AMBIGUOUS AND THE SWEEP CANNOT SEE IT.
  // Without this the worker is inert and silent against a store that has no bucket:
  // every object answers 404, every 404 reads as "not yet", and the log says nothing.
  if (!(await (deps.probeBucket ?? bucketPresent)(store))) {
    logger.log("error", "the object store has no bucket; nothing can be verified");
    return { ...result, storeUnavailable: true };
  }

  // A SWEEP IS A WHOLE PASS, NOT A FIRST PAGE, AND THAT IS WHAT THE CHAPTER'S HEADLINE
  // FIGURE MEANS. *"The whole backlog is 4.2 s serial"* is the argument for a sweep over
  // a client notice; a fixed first page makes it describe something the code does not
  // do. Measured against a lane with real history: 858 objects in the window, a batch of
  // fifty, and **the head never moves** — an object nobody uploaded to stays `pending`
  // until FR-MED-10 reaps it, so a fresh upload was row 858 and was never reached.
  //
  // KEYSET, NOT OFFSET. Each page asks for objects created after the last one seen,
  // which is a range scan on `media_objects_pending_age` rather than a walk past
  // everything already read.
  //
  // AND THE PASS IS BOUNDED. `maxPages` exists so one sweep cannot run forever against a
  // queue growing faster than it drains; the objects it does not reach are the newest,
  // and the next sweep starts at the head again. That is the right end to give up on:
  // an object a second late is better than an object never looked at.
  const batch = deps.batch ?? 50;
  const maxPages = deps.maxPages ?? 100;
  const objects: PendingObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await api.pending(batch, cursor);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.created_at;
    objects.push(...rows.filter((o) => !refusedByTheApi.has(o.id)));
    if (rows.length < batch) break;
  }
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
        // A 4xx THAT IS NOT 404 OR 422 IS THIS WORKER'S BUG, NOT A TRANSIENT FAILURE,
        // and retrying it costs a scan every interval forever.
        //
        // MEASURED, AND IT IS WHY THIS BRANCH EXISTS. A signed-shift defect in the PNG
        // reader produced a negative `width`, the verdict schema refused it with 400,
        // and the worker re-streamed the same eight objects through ClamAV on every
        // sweep — eight objects, every second, with the log saying exactly what was
        // wrong and nothing acting on it. The object stays `pending`, which is the safe
        // state and lets a fixed worker resolve it; what this stops is paying for the
        // scan again while this process lives.
        //
        // IN MEMORY AND NOT IN A COLUMN, deliberately. A `failed_verdict_at` column
        // would be a second place the object's fate is recorded, and the thing it
        // records is a bug that will be fixed by a deploy — which clears this set for
        // free.
        if (error.status >= 400 && error.status < 500) refusedByTheApi.add(object.id);
        continue;
      }
      throw error;
    }
  }

  return result;
}
