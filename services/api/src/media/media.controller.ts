import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { RequestWithPrincipal } from "../auth/principal";
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
}
