import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  UseGuards,
} from "@nestjs/common";

import {
  BACKFILL_LIMIT,
  internalBackfillRequestSchema,
  type InternalBackfillRequest,
  type InternalBackfillResponse,
  type Message,
} from "@relay/protocol";

import { EnvironmentContextGuard } from "../messages/environment-context.guard";
import { Repository, type MessageWithSender } from "../db/repository";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";

// The api's half of resume (chapter 2.7): everything the client has not
// applied yet, per channel, capped. It is a READ behind a POST, because the
// request carries a map — cursors in a query string would be a length limit
// waiting to be hit, and this route is internal, uncacheable, and called
// once per connect.
//
// The controller's real job is SHAPE: the repository returns rows, the
// gateway needs frames, and this is the boundary where one becomes the
// other (the same division of labour 2.6 settled for the public send).
@Controller("internal")
@UseGuards(EnvironmentContextGuard)
export class BackfillController {
  constructor(private readonly repo: Repository) {}

  @Post("backfill")
  async backfill(
    @Body(new ZodValidationPipe(internalBackfillRequestSchema))
    body: InternalBackfillRequest,
    @Headers("x-relay-user") userExternalId?: string,
  ): Promise<InternalBackfillResponse> {
    if (!userExternalId) throw new BadRequestException("missing x-relay-user");
    const user = await this.repo.getUserByExternalId(userExternalId);
    // An unknown user resumes nothing — the same answer memberships gives,
    // for the same reason: delivery is not identity forensics.
    if (!user) return { channels: {} };

    const pages = await this.repo.backfill(
      user.id,
      body.cursors,
      BACKFILL_LIMIT,
    );
    const channels: InternalBackfillResponse["channels"] = {};
    for (const [channelId, page] of Object.entries(pages)) {
      const messages = page.messages.flatMap((row) => toFrame(row, channelId));
      channels[channelId] = {
        messages,
        // Truncation is reported as the READ found it, not as the mapping
        // left it: dropping an unrenderable row does not mean the client
        // should go page history, and hiding a real cap would.
        truncated: page.truncated,
      };
    }
    return { channels };
  }
}

/** A row becomes a frame, or it becomes nothing.
 *
 * Two kinds of row cannot be a `message.created` payload, and both are
 * honest gaps rather than bugs to paper over:
 *
 *   - **No sender.** Every row written through the socket before 2.6's fix
 *     has `user_id` NULL. There is no truthful value to invent, and the
 *     wire contract requires one.
 *   - **No text.** A tombstone (FR-MSG-08) is not a creation. When deletes
 *     arrive in Part 4 they get `message.deleted`, and resume will carry
 *     that frame instead.
 *
 * The client is not left guessing: sequence numbers are contiguous per
 * channel, so a skipped row shows up as a gap the SDK detects and repairs
 * through 2.4's history endpoint (FR-RTM-03's safety net, one layer down).
 */
function toFrame(row: MessageWithSender, channelId: string): Message[] {
  if (row.user === null || row.text === null) return [];
  return [
    {
      id: row.id,
      channel: channelId,
      seq: row.seq,
      user: row.user,
      text: row.text,
      created_at: row.created_at,
    },
  ];
}
