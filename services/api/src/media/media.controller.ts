import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { RequestWithPrincipal } from "../auth/principal";
import { protocolError } from "../protocol-error";
import { MediaService, type SlotRequest } from "./media.service";

// THE UPLOAD SLOT (FR-MED-01). One route, and the bytes do not come through it.
//
// `Accepts("application", "user")` — BOTH, which is FR-MED-01's own wording: "on
// request (user token or API key)". A photo sent by a person and an attachment
// uploaded by a customer's backend are the same operation, and the difference shows
// up one chapter later, when FR-MED-06 asks whether the sender uploaded it. That
// question needs the row to remember which of the two asked, which is why `user_id`
// is nullable rather than filled in with something.
@Controller("v1/media")
@UseGuards(CredentialGuard)
@Accepts("application", "user")
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** 201 with the id and the URL. The URL is derived and never stored: the store
   * enforces its own expiry, and two records of when it lapses would be one too
   * many (constitution IV, one level down). */
  @Post()
  create(@Body() body: SlotRequest, @Req() req: RequestWithPrincipal) {
    // SOFT, the way `messages.controller.ts` reads it: the guard has already refused
    // anything without a principal, so the optional chain is a branch that cannot go
    // both ways — and an unreachable arm in a file the ratchet pins at 100% is a
    // coverage failure with no fix but a comment.
    const actingUser =
      req.principal?.kind === "user" ? req.principal.userExternalId : undefined;
    return this.media.createSlot(body, actingUser);
  }

  /** A signed GET for an object the caller may read (FR-MED-08). 200 with a URL and an
   * expiry, or 404 — the same 404 for an object of another tenant, an object referenced
   * only where the caller cannot read, and an id no object has.
   *
   * THE PATH PARAMETER IS VALIDATED, AND NO OTHER ROUTE IN THIS API DOES THAT. Measured
   * against the composed api before this route existed:
   *
   *     GET /v1/channels/not-a-uuid/messages
   *     500 {"code":"internal_error","message":"unexpected internal error"}
   *
   * A malformed uuid reaches the driver, Postgres answers `invalid input syntax for type
   * uuid`, and the filter has no rung for it — a caller-triggered 500 on sixteen shipped
   * routes, thirteen taking `channelId` and three taking `messageId`. It is chapter
   * 4.11's research R3 exactly, which found the same defect in a request BODY, measured
   * it, and fixed it with `z.uuid()` — while nobody looked at the path. The other sixteen
   * are recorded in `gaps.md` with their measurement rather than repaired here, because a
   * chapter about signed delivery that rewrites three controllers is teaching two things
   * badly.
   *
   * NOT THROUGH `ZodValidationPipe`, AND THE REASON IS ITS `field`. That pipe names the
   * field from the zod issue's `path`, which is empty for a scalar and then omitted — so
   * the reuse would answer 400 without saying which parameter was wrong. The check is
   * three lines here and names `mediaId`. */
  @Get(":mediaId")
  deliver(@Param("mediaId") mediaId: string, @Req() req: RequestWithPrincipal) {
    if (!z.uuid().safeParse(mediaId).success) {
      throw protocolError(
        "invalid_request",
        "mediaId must be a uuid",
        400,
        "mediaId",
      );
    }
    const actingUser =
      req.principal?.kind === "user" ? req.principal.userExternalId : undefined;
    return this.media.deliver(mediaId, actingUser);
  }
}
