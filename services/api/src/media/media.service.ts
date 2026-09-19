import { randomUUID } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";

import { Repository } from "../db/repository";
import { protocolError } from "../protocol-error";
import { KIND_CAPS, kindOf } from "./kinds";
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

/** FR-MED-01's fifteen minutes. The STORE enforces it — a URL past its expiry comes
 * back `AccessDenied · Request has expired` from the store's own clock — and
 * `expires_at` below is published so a client can decide whether to reuse the URL
 * rather than so anything here can check it. */
const SLOT_SECONDS = 900;

@Injectable()
export class MediaService {
  private readonly store: StoreConfig = storeConfig();

  constructor(private readonly repo: Repository) {}

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

    return {
      media_id: id,
      state: "pending",
      upload_url,
      expires_at: new Date(Date.now() + SLOT_SECONDS * 1000).toISOString(),
    };
  }

}
