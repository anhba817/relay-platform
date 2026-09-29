import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import {
  internalMediaVerdictRequestSchema,
  type InternalMediaPendingResponse,
  type InternalMediaVerdictRequest,
  type InternalMediaVerdictResponse,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { Db } from "../db/client";
import {
  channelsReferencingMediaIn,
  pendingMediaObjects,
  recordMediaVerdict,
} from "../db/repository";
import { LOGGER } from "../logger";
import { kindOf } from "../media/kinds";
import type { Publisher } from "../outbox/publisher";
import { ANALYTICS_PUBLISHER } from "../webhooks/analytics";
import { publishStorageDelta } from "../metering/storage-event";
import {
  MESSAGE_PUBLISHER,
  type MessagePublisher,
} from "../fanout/publisher";
import { deleteObject, storeConfig } from "../media/store";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";
import { protocolError } from "../protocol-error";

// THE ONLY SERVICE THAT READS THE BYTES TALKS TO POSTGRES THROUGH HERE.
//
// ADR-04 keeps every datastore behind the api, so the worker's two questions — what is
// there to verify, and here is what I found — are two HTTP routes rather than a second
// connection pool. `dispatch.controller.ts` is the same seam for the same reason and
// `services/dispatcher/src/api-client.ts` is its one client.
//
// ITS OWN CONTROLLER, BECAUSE THE DECORATOR IS THE ANSWER TO "WHO MAY CALL THIS".
// `usage.controller.ts` split off from the user-token routes on exactly this argument:
// a class-level `@Accepts` stops meaning anything the moment two credential classes
// share a class.
@Controller("internal/media")
@UseGuards(CredentialGuard)
// NAMED, NOT BARE. `@Accepts("platform")` does not compile — `AcceptSpec` requires a
// platform route to list its services — and the reason is in `credential.guard.ts`:
// *"an authorization that can be omitted is one that will be, and the omission is
// invisible."* The gateway terminates connections from the public internet; this
// service reads customer bytes; neither should be able to stand in for the other.
//
// AND `"media-worker"` IS UNWRITEABLE UNTIL `PLATFORM_SERVICES` HAS THE ROW, which is
// what made the worker's own credential a hard dependency rather than a preference.
// The union widening on its own compiles fine — measured, `tsc --noEmit` exit 0 — so
// this line, not the union, is the forcing function.
@Accepts({ platform: ["media-worker"] })
export class MediaVerificationController {
  constructor(
    @Inject("DB") private readonly db: Db,
    @Inject(LOGGER) private readonly logger: Logger,
    // 4.16. `InternalModule` already provides `ANALYTICS_PUBLISHER` — this controller's
    // neighbour, the dispatcher, publishes webhook attempts through it.
    @Inject(ANALYTICS_PUBLISHER) private readonly analytics: Publisher,
    // FR-MED-07's producer. `InternalModule` declares its own — `MessagesModule`
    // withholds this token — and without that declaration this line is a runtime
    // failure on the first request that lint and typecheck both pass.
    @Inject(MESSAGE_PUBLISHER) private readonly publisher: MessagePublisher,
  ) {}

  /** `GET /internal/media/pending` — the sweep's batch.
   *
   * NO TENANT PARAMETER, AND THAT IS THE ISOLATION PROPERTY. One worker serves every
   * environment, so there is nothing for a caller to scope and nothing a forged call
   * could widen. Compare `/internal/usage/connections`, which names environments in its
   * body and therefore has to refuse an application credential.
   *
   * OLDEST FIRST, so an object that keeps failing does not starve the queue behind it
   * and the 24-hour boundary FR-MED-10 will own is approached from the right end. */
  @Get("pending")
  async pending(
    @Query("limit") limit?: string,
    /** A `created_at` from a previous page, so a sweep can cover the whole window.
     * Absent means the head of the queue. */
    @Query("after") after?: string,
  ): Promise<InternalMediaPendingResponse> {
    // A BOUND THE CALLER CANNOT RAISE. The worker streams every object it is handed
    // through a scanner, so a batch is a memory commitment as much as a query — and the
    // sweep is a loop, so a smaller batch costs a round trip rather than a record.
    const parsed = Number(limit ?? 50);
    const size =
      Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    // A MALFORMED CURSOR IS THE HEAD OF THE QUEUE, NOT A 500. This route's only caller
    // builds the value from a previous response, so a bad one is a bug rather than an
    // attack — and starting over is the outcome that loses no object.
    const cursor = after ? new Date(after) : undefined;
    const rows = await pendingMediaObjects(
      this.db,
      size,
      cursor && !Number.isNaN(cursor.getTime()) ? cursor : undefined,
    );
    return {
      objects: rows.map((r) => ({
        id: r.id,
        object_key: r.objectKey,
        // 4.15: the worker needs the tenant to name a rendition's key in the platform's
        // own `${environment_id}/${id}` layout. The query already selected it.
        environment_id: r.environmentId,
        mime_type: r.mimeType,
        declared_bytes: r.declaredBytes,
        created_at: r.createdAt.toISOString(),
      })),
    };
  }

  /** `POST /internal/media/:mediaId/verdict` — what the worker found.
   *
   * IDEMPOTENT BY STATE, NOT BY KEY. The `UPDATE … WHERE state = 'pending'` in
   * `recordMediaVerdict` is the compare-and-set: two workers racing one object resolve
   * because the second updates no rows. No lease, no lock, no heartbeat — the
   * transition itself is the claim.
   *
   * AND THE REFUSAL IS THE PART WORTH HAVING. A second `ready` for a `ready` object is
   * an ordinary retry and answers 200. A verdict for a `rejected` object is refused,
   * because its bytes are gone: answering 200 would let a stale worker move a state
   * whose object no longer exists, and the row would then promise a client something
   * the store cannot serve. */
  @Post(":mediaId/verdict")
  @HttpCode(200)
  async verdict(
    // A MALFORMED ID IS A 400 HERE AND A 500 ON SIXTEEN PUBLIC ROUTES (`gaps.md`
    // 058-3). This route is new, so it costs nothing to get right; the sixteen are
    // recorded with their bill rather than repaired.
    @Param("mediaId", new ParseUUIDPipe()) mediaId: string,
    @Body(new ZodValidationPipe(internalMediaVerdictRequestSchema))
    body: InternalMediaVerdictRequest,
  ): Promise<InternalMediaVerdictResponse> {
    // SPREAD RATHER THAN ASSIGNED, because `exactOptionalPropertyTypes` makes
    // `{ width: undefined }` a different thing from `{}` and the first version of this
    // wrote the former. A probe that finds no dimensions must leave the column alone,
    // not set it to a value that reads back the same and typechecks differently.
    const result = await recordMediaVerdict(this.db, {
      id: mediaId,
      verdict: body.verdict,
      ...(body.verified_bytes !== undefined && {
        verifiedBytes: body.verified_bytes,
      }),
      ...(body.verified_type !== undefined && {
        verifiedType: body.verified_type,
      }),
      ...(body.verdict === "ready" &&
        body.width !== undefined && { width: body.width }),
      ...(body.verdict === "ready" &&
        body.height !== undefined && { height: body.height }),
      ...(body.verdict === "ready" &&
        body.duration_ms !== undefined && { durationMs: body.duration_ms }),
      ...(body.verdict === "rejected" && { reason: body.reason }),
      // FR-MED-05. The bytes are already in the store — the worker wrote them before it
      // asked for this transition, so a verdict that never arrives leaves an orphaned
      // object rather than a row pointing at nothing. That is the cheaper direction:
      // FR-MED-10's reap collects bytes, and no reaper can invent a missing rendition.
      ...(body.verdict === "ready" &&
        body.rendition !== undefined && {
          rendition: {
            id: body.rendition.id,
            kind: body.rendition.kind,
            objectKey: body.rendition.object_key,
            bytes: body.rendition.bytes,
            width: body.rendition.width,
            height: body.rendition.height,
          },
        }),
      ...(body.verdict === "ready" &&
        body.rendition_failed_reason !== undefined && {
          renditionFailedReason: body.rendition_failed_reason,
        }),
    });

    if (result.state === null) {
      throw protocolError(
        "not_found",
        "no media object with that id",
        HttpStatus.NOT_FOUND,
      );
    }

    if (!result.applied && result.state === "rejected") {
      // 422, NOT 409. `ProtocolErrorFilter`'s ladder has nine rungs and 409 is not one
      // of them, so a `ConflictException` naming no code answers `internal_error` —
      // which `connection_environment_conflict` exists in the registry because somebody
      // measured. 422 is the code for a well-formed request the platform understood and
      // cannot carry out, the caller's action is the same either way, and the registry
      // stays at 34.
      throw protocolError(
        "unprocessable_request",
        "this object was rejected and its bytes are gone; a verdict cannot change that",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // THE BYTES GO AFTER THE ROW MOVES, NOT BEFORE (FR-MED-04). The row is the audit
    // record and it stays; only the object is destroyed. Ordering it this way means the
    // one inconsistency reachable by a crash is a `rejected` row whose bytes survive —
    // recoverable, and unattachable in the meantime, because the predicate that admits
    // an attachment reads the state and not the store.
    if (result.applied && body.verdict === "rejected") {
      const removed = await deleteObject(storeConfig(), result.objectKey!);
      if (!removed) {
        // NOT A FAILURE OF THE VERDICT. The object is already unattachable; what is
        // left is bytes nobody can reach through this platform, which FR-MED-10's reap
        // will collect. Logged so it is countable rather than silent.
        this.logger.log("error", "rejected media object's bytes were not deleted", {
          media_id: mediaId,
        });
      }
    }

    // FR-MED-07's SECOND SENTENCE, AND IT HANGS OFF `applied` RATHER THAN OFF THE
    // REQUEST. The compare-and-set already distinguishes *a transition happened* from
    // *a verdict arrived*: a stale worker's second verdict updates no rows, answers
    // `applied: false`, and must announce nothing. A producer keyed on the request
    // would tell every subscriber twice.
    //
    // **AFTER `deleteObject`, WHICH IS A CHOICE AND NOT AN ACCIDENT.** For a rejection
    // the bytes are destroyed above; publishing first would announce `rejected` while
    // they still exist. Neither order is observable to a client — FR-MED-08's gate
    // reads the state and not the store, so a `rejected` object is unreadable either
    // way — so the tie is broken by saying the true thing later rather than the
    // convenient thing sooner. The cost is one store round trip on the worker's
    // request, on the rejection path only.
    //
    // AND THERE IS NO TRANSACTION TO BE INSIDE OF. `recordMediaVerdict` is an
    // `UPDATE … RETURNING` and, when nothing applies, a follow-up `SELECT`; this
    // controller manages none. A crash between the update and the publish loses one
    // frame, and the floor repairs it: every door already serves the state, so the
    // client learns it on the next read. That is the same shape 4.13 recorded for the
    // upload sweep — the mechanism is the state, the frame is the optimisation.
    if (result.applied && result.environmentId !== null) {
      await this.announce(result.environmentId, mediaId, result.state);
      this.meterStorage(mediaId, body, result);
    }

    return {
      applied: result.applied,
      state: result.state as InternalMediaVerdictResponse["state"],
    };
  }

  /** FR-MED-12's deltas for a verdict that applied (4.16).
   *
   * **AFTER `recordMediaVerdict` RETURNS, NOT INSIDE IT**, and not awaited —
   * `webhooks/analytics.ts` records why: *"guarantee independence → the publish happens
   * after the commit, outside it"*, because a blocked outcome transaction is what
   * constitution III names as a design failure. `announce` sits here for the same reason
   * and is the precedent this follows.
   *
   * **HANGING OFF `applied`, WHICH IS THE COMPARE-AND-SET.** A stale worker's second
   * verdict updates no rows and emits nothing, so FR-005's exactly-once is the same
   * mechanism 4.14 used for `media.updated` rather than a second guard.
   *
   * TWO CAUSES, AND THE SIGNS ARE OPPOSITE. A rejection takes the object's declared bytes
   * back out, because the quota counts `state <> 'rejected'` and the meter agrees by
   * construction. A rendition adds its own. */
  private meterStorage(
    mediaId: string,
    body: InternalMediaVerdictRequest,
    result: { environmentId: string | null; declaredBytes: number | null; mimeType: string | null },
  ): void {
    if (result.environmentId === null) return;
    // `kindOf` returns null for a type outside `ALLOWED_TYPES`, which cannot reach here —
    // the slot route refused it. Recorded rather than asserted: a record with no kind
    // would land as `''` in a `LowCardinality(String)` column, and 4.4 measured that an
    // absent field and an explicit empty string are indistinguishable there.
    const kind = result.mimeType === null ? null : kindOf(result.mimeType);
    if (kind === null) return;

    if (body.verdict === "rejected" && result.declaredBytes !== null) {
      void publishStorageDelta(this.analytics, this.logger, {
        environmentId: result.environmentId,
        mediaId,
        cause: "rejected",
        kind,
        bytesDelta: -result.declaredBytes,
        occurredAt: new Date(),
      });
      return;
    }

    if (body.verdict === "ready" && body.rendition !== undefined) {
      void publishStorageDelta(this.analytics, this.logger, {
        environmentId: result.environmentId,
        mediaId: body.rendition.id,
        cause: "rendition",
        kind,
        bytesDelta: body.rendition.bytes,
        occurredAt: new Date(),
      });
    }
  }

  /** One frame per channel holding a message that references this object.
   *
   * **AN EMPTY LIST IS SUCCESS, AND IT IS THE COMMON CASE.** 4,725 of the development
   * lane's 5,403 media objects are referenced by nothing — slots taken and never used.
   * FR-006: publish nothing, fail nothing.
   *
   * **PER CHANNEL AND NOT PER MESSAGE.** `channelsReferencingMediaIn` is
   * `selectDistinct` over channels, so two messages in one channel attaching one object
   * produce one frame. A client rendering per message finds its own by media id; the
   * frame answers *this object changed*.
   *
   * **AND IT NEVER THROWS**, which is `publishRevision`'s own contract: the row is
   * committed and the worker's verdict must not fail because a fabric is down. */
  private async announce(
    environmentId: string,
    mediaId: string,
    state: string | null,
  ): Promise<void> {
    // **THIS GUARD IS UNREACHABLE AT RUNTIME AND LOAD-BEARING AT COMPILE TIME**, and
    // the per-arm probe is what established the difference: deleting it turns nothing
    // red across the whole suite. It cannot fire, because `announce` is called only
    // when the compare-and-set applied, and a compare-and-set that applied set the
    // state to the verdict — which is `ready` or `rejected` and nothing else.
    //
    // It stays because `state` arrives typed `string | null` and this is what narrows
    // it to the two values the fabric arm accepts. Deleting it would need a cast, and a
    // cast is a claim the compiler stops checking. **4.11 found an early return that
    // was an optimisation wearing a branch's clothes; this is the other kind — a type
    // narrowing wearing a runtime guard's clothes**, and saying which it is costs three
    // lines and stops somebody later reading its coverage as a gap.
    if (state !== "ready" && state !== "rejected") return;
    const channels = await channelsReferencingMediaIn(this.db, environmentId, mediaId);
    for (const channel of channels) {
      await this.publisher.publishRevision(
        { kind: "media", media_id: mediaId, channel, state },
        { requestId: "media-verdict", environmentId },
      );
    }
  }
}
