import {
  MEDIA_STORED_TYPE,
  mediaStoredSubject,
  type MediaStoredRecord,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import type { Publisher } from "../outbox/publisher";

/** FR-MED-12's producer (chapter 4.16). One function, four causes.
 *
 * **THE CAUSES ARE FOUR AND SO ARE THE CALLERS, SINCE CHAPTER 4.20.** `reserved` comes from the slot
 * route, `rejected` and `rendition` from the verdict handler, and `deleted` from
 * **nothing yet** — chapter 4.15 established that no code path deletes a
 * `media_objects` row, because the rejection path removes bytes and keeps the row on
 * purpose (`0018`: *"a rejected object's row is all that survives it"*). **`deleted`
 * now comes from `retention/sweep.ts`**, which destroys an object whose every
 * referencing message has expired — the first code path in this platform that removes
 * a `media_objects` row at all. FR-MED-10's 24-hour orphan reaper is still row 22's and
 * will be the second.
 *
 * AND WITHOUT THIS THE SWEEP WOULD HAVE BEEN SILENTLY WRONG IN ONE DIRECTION ONLY. The
 * operational quota is `sum(declared_bytes)` over rows (SRS 1.17) and corrects itself
 * the moment the row goes, so every operational assertion stays green while the
 * analytical meter — a sum of events — keeps charging for bytes that no longer exist.
 * That asymmetry is what made it easy to miss and expensive to miss.
 *
 * Following `CLAUDE.md`'s convention: a claim about when a symbol runs names the thing
 * that runs it, so *"called on deletion"* would be false today and is written as what it
 * is. The convention exists because `ensureBucket` said *"on boot, every boot"* for two
 * chapters while every caller was a test.
 *
 * **AND THE CONSEQUENCE IS NOT COSMETIC.** With no negative arm in service, the metered
 * level only ever rises, so DR-17's reconciliation cannot fail in the direction it exists
 * to catch. The chapter says that rather than letting a green comparison read as
 * agreement. */
export type StorageCause = MediaStoredRecord["event"];

export interface StorageFacts {
  environmentId: string;
  mediaId: string;
  cause: StorageCause;
  kind: MediaStoredRecord["kind"];
  /** Signed. The quota's quantity — `declared_bytes` — positive on `reserved` and
   * `rendition`, negative on `rejected` and `deleted`. **Carried, never derived from
   * `cause`**: a reader that infers the sign puts the rule in a second place, and
   * `stored_delta` one table over is what that looks like two chapters later. */
  bytesDelta: number;
  occurredAt: Date;
}

/** **NOT AWAITED BY ITS CALLERS, AND NEVER INSIDE A TRANSACTION.**
 *
 * `webhooks/analytics.ts` records the decision this follows, in full: *"guarantee
 * independence → the publish happens after the commit, outside it, and a crash in that
 * gap loses the record"*, chosen because *"a blocked outcome transaction is a customer's
 * webhooks stopping because a metering pipeline is unwell — which constitution III names
 * as a design failure in as many words."*
 *
 * **THE SECOND REASON IS WORSE THAN THE COUPLING.** A publish inside a transaction that
 * rolls back emits a delta for a slot that was never created — a permanent overcount,
 * and the whole argument of this chapter is that nothing corrects one.
 *
 * So a lost record is the accepted cost, the same one FR-WHK-06 accepted, and DR-17's
 * reconciliation against the object store is what bounds it. */
export async function publishStorageDelta(
  publisher: Publisher,
  logger: Logger,
  facts: StorageFacts,
): Promise<void> {
  try {
    await publisher.publish({
      subject: mediaStoredSubject(facts.environmentId),
      // ONE ID PER FACT, so a redelivery is deduplicated by `Nats-Msg-Id` rather than
      // counted twice. The media id alone would collide across causes — a rejection
      // follows a reservation for the same object — so the cause is part of it.
      id: `${facts.mediaId}:${facts.cause}`,
      payload: {
        type: MEDIA_STORED_TYPE,
        environment_id: facts.environmentId,
        media_id: facts.mediaId,
        event: facts.cause,
        kind: facts.kind,
        bytes_delta: facts.bytesDelta,
        occurred_at: facts.occurredAt.toISOString(),
      } satisfies MediaStoredRecord,
    });
  } catch (error) {
    // One line, no rethrow — `publishRequest`'s shape, for `publishRequest`'s reason.
    // The caller's work is committed; there is nothing this failure can usefully undo.
    logger.log("error", "storage_delta.publish_failed", {
      media_id: facts.mediaId,
      cause: facts.cause,
      error: String(error),
    });
  }
}
