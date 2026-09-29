import { randomUUID } from "node:crypto";

import { BadRequestException, HttpStatus, Inject, Injectable } from "@nestjs/common";

import type { Logger } from "@relay/service-kit";

import { Repository } from "../db/repository";
import { protocolError } from "../protocol-error";
import { KIND_CAPS, kindOf } from "./kinds";
import { LOGGER } from "../logger";
import { publishStorageDelta } from "../metering/storage-event";
import type { Publisher } from "../outbox/publisher";
import { ANALYTICS_PUBLISHER } from "../webhooks/analytics";
import { presign } from "./presign";
import { storeConfig, storeReady, type StoreConfig } from "./store";

/** What a caller declares. Nothing here is verified — FR-MED-03 is a later chapter,
 * and the quota arithmetic below is over these numbers rather than over bytes. */
export interface SlotRequest {
  filename: string;
  mime_type: string;
  bytes: number;
}

export interface Slot {
  media_id: string;
  state: "pending";
  upload_url: string;
  expires_at: string;
}

export interface Delivery {
  url: string;
  expires_at: string;
}

/** FR-MED-08's one hour, against the upload slot's fifteen minutes.
 *
 * THE URL OUTLIVES THE AUTHORISATION THAT PRODUCED IT AND NOTHING HERE CAN FIX THAT. A
 * caller issued a URL at minute 0 and removed from the channel at minute 1 holds a
 * working link until minute 60: the store checks a signature and has never heard of a
 * channel. Shortening the window trades one exposure for another — a URL that expires
 * while a page is still rendering is a broken image — and revocation would mean the api
 * standing in front of the bytes, which is what ADR-13 was decided against. The clause
 * names the hour, so the hour is what ships and the window is published as a cost. */
const DELIVERY_SECONDS = 3600;

/** FR-MED-01's fifteen minutes. The STORE enforces it — a URL past its expiry comes
 * back `AccessDenied · Request has expired` from the store's own clock — and
 * `expires_at` below is published so a client can decide whether to reuse the URL
 * rather than so anything here can check it. */
const SLOT_SECONDS = 900;

@Injectable()
export class MediaService {
  private readonly store: StoreConfig = storeConfig();

  constructor(
    private readonly repo: Repository,
    @Inject(ANALYTICS_PUBLISHER) private readonly analytics: Publisher,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async createSlot(input: SlotRequest, userExternalId?: string): Promise<Slot> {
    // ORDER MATTERS AND IT IS THE CLAUSE'S. Type, then size, then quota: the first two
    // are facts about the request and the third needs a read, so refusing in this order
    // means a request that was never going to be accepted does not touch the database.
    const kind = kindOf(input.mime_type);
    if (kind === null) {
      throw protocolError(
        "media_type_not_allowed",
        `'${input.mime_type}' is not an accepted media type`,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        "mime_type",
      );
    }

    const cap = KIND_CAPS[kind];
    if (input.bytes > cap) {
      throw protocolError(
        "media_too_large",
        `${input.bytes} bytes exceeds the ${cap}-byte limit for ${kind}`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        "bytes",
      );
    }

    // THE STORE, ASKED BEFORE ANYTHING IS WRITTEN (FR-017).
    //
    // AFTER THE TWO FREE REFUSALS AND BEFORE THE ONE THAT WRITES, which is the only
    // position that satisfies FR-009 without a compensating delete. A probe placed
    // after the reservation would have to un-reserve the bytes it just committed; a
    // probe placed first would spend a round trip on `application/x-evil`.
    //
    // AND IT MEANS A TENANT OVER QUOTA WITH A DOWN STORE IS TOLD THE STORE IS DOWN,
    // which is the one ordering consequence worth naming. Retrying will then produce
    // `media_storage_exhausted` and the client will have learned both facts in two
    // requests instead of one. The opposite order tells a client to delete media when
    // nothing could have been stored anyway — permanent advice about a transient
    // state, which is the failure this code exists to prevent.
    if (!(await storeReady(this.store))) {
      throw protocolError(
        "media_storage_unavailable",
        "the object store is not reachable; this is temporary and the request can be retried",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // THE USER, RESOLVED BEFORE THE TRANSACTION AND LEFT NULL FOR AN API KEY.
    // FR-MED-06's chapter asks whether the sender uploaded it, and cannot ask that of
    // a row that wrote something else in place of the absence.
    const user =
      userExternalId === undefined
        ? null
        : await this.repo.getUserByExternalId(userExternalId);

    const id = randomUUID();
    const objectKey = `${this.repo.environment}/${id}`;

    // ONE CALL, AND THE TRANSACTION IS THE REPOSITORY'S. The check reads what the
    // insert writes, so they are one statement's worth of work — and the query engine
    // lives in `db/` because a lint rule says so in constitution I's words. The first
    // version of this method held the drizzle query and was refused by it, which is
    // chapter 4.7's finding arriving one chapter later.
    const reserved = await this.repo.reserveMediaSlot({
      id,
      userId: user?.id ?? null,
      filename: input.filename,
      mimeType: input.mime_type,
      declaredBytes: input.bytes,
      objectKey,
    });

    if (!reserved.reserved) {
      throw protocolError(
        "media_storage_exhausted",
        `this environment has ${reserved.committed} of ${reserved.cap} stored bytes ` +
          `committed; ${input.bytes} more would exceed the limit`,
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // DERIVED, NOT STORED (FR-003). Two sources of truth for one expiry would be one
    // too many, and the store is the authoritative one.
    const upload_url = presign({
      method: "PUT",
      ...this.store,
      key: objectKey,
      expiresIn: SLOT_SECONDS,
    });

    // FR-MED-12's `reserved` DELTA — **AFTER THE COMMIT, OUTSIDE THE TRANSACTION, AND NOT
    // AWAITED.** `webhooks/analytics.ts` records the decision: *"guarantee independence →
    // the publish happens after the commit, outside it, and a crash in that gap loses the
    // record"*, because a blocked outcome transaction is what constitution III names as a
    // design failure. And a publish INSIDE a transaction that rolls back would emit a
    // delta for a slot that was never created — a permanent overcount, which is the whole
    // thing this chapter argues nothing corrects.
    //
    // THE BYTES ARE THE QUOTA'S (FR-002). `reserveMediaSlot` sums `declared_bytes` where
    // `state <> 'rejected'`, so a `pending` object is already charged and the meter says
    // the same number for the same reason rather than by agreement.
    void publishStorageDelta(this.analytics, this.logger, {
      environmentId: this.repo.environment,
      mediaId: id,
      cause: "reserved",
      kind,
      bytesDelta: input.bytes,
      occurredAt: new Date(),
    });

    return {
      media_id: id,
      state: "pending",
      upload_url,
      expires_at: new Date(Date.now() + SLOT_SECONDS * 1000).toISOString(),
    };
  }

  /** A signed GET for an object this caller may read, or a refusal (FR-MED-08).
   *
   * THE SIGNER NEEDED NO CHANGE AND THAT IS ASSERTED RATHER THAN ARRANGED. `presign` has
   * taken `"GET"` since chapter 4.10, and `presign.itest.ts:53` — titled "FR-MED-08's
   * precondition" — already proves the other half of this clause from outside the
   * container: a signed GET answers 200, an unsigned one 403, a tampered one 403. Half of
   * what this chapter was asked for was built two chapters ago, and re-proving it would
   * claim work somebody else did.
   *
   * THE EXTERNAL ID IS RESOLVED BEFORE THE PREDICATE SEES IT. `req.principal.userExternalId`
   * is `tuan` or `delivery-bot`; `channelVisibleTo` reaches `isMember`, which compares
   * against `members.user_id`, a `uuid` column. Handing one straight through is a
   * caller-triggered 500 where a tenant's ids are not UUID-shaped — and something worse
   * where they are, because no parse fails, `isMember` simply returns false, and every
   * private channel silently refuses every member while every public one still works.
   *
   * `endpoint` AND NOT `internalEndpoint` (4.11's FR-026). This URL is handed to a client
   * outside the network and the host is inside the SigV4 signature, so signing with the
   * api's own address produces a URL the store refuses rather than one that is slow. */
  async deliver(mediaId: string, userExternalId?: string): Promise<Delivery> {
    let userId: string | undefined;
    if (userExternalId !== undefined) {
      const user = await this.repo.getUserByExternalId(userExternalId);
      if (!user) throw new BadRequestException("unknown user");
      userId = user.id;
    }

    const objectKey = await this.repo.readableMediaObjectKey(mediaId, userId);
    // ONE ANSWER FOR THREE CONDITIONS — another environment's object, an object
    // referenced only where this caller cannot read, and an id no object has. The
    // precedent is `channelVisibleTo`'s own: the leak it was written to close was a
    // private channel answering `200, empty page` where an absent one answered 404, and
    // the fix was to make both answer identically. A refusal that names its cause reports
    // whether somebody else's object exists.
    if (objectKey === undefined) {
      throw protocolError(
        "not_found",
        "no such media object",
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      url: presign({
        method: "GET",
        ...this.store,
        key: objectKey,
        expiresIn: DELIVERY_SECONDS,
      }),
      expires_at: new Date(Date.now() + DELIVERY_SECONDS * 1000).toISOString(),
    };
  }
}
