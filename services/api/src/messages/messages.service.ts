import { Injectable, NotFoundException } from "@nestjs/common";

import {
  ChannelNotFoundError,
  Repository,
  type MessageRow,
} from "../db/repository";
import type { SendMessageBody } from "./messages.schema";

// The thin layer between HTTP and the repository (chapters 2.2 + 2.3). It
// owns two things: turning the layer's domain error into the wire's 404,
// and translating the repository's `duplicate: true` into FR-MSG-04's
// "201-equivalent semantics" — the retry returns the original message,
// indistinguishable from a fresh send (the `duplicate` flag stays internal).
@Injectable()
export class MessagesService {
  constructor(private readonly repo: Repository) {}

  async send(
    channelId: string,
    body: SendMessageBody,
  ): Promise<MessageRow> {
    try {
      const result = await this.repo.sendMessage(channelId, {
        text: body.text,
        metadata: body.metadata,
        ...(body.idempotency_key != null && {
          idempotencyKey: body.idempotency_key,
        }),
      });
      // The internal duplicate flag never reaches the wire: the client
      // sees the same body whether this was the original send or the
      // retry that recovered it (FR-MSG-04's 201-equivalent semantics).
      return {
        id: result.id,
        channel_id: result.channel_id,
        seq: result.seq,
        text: result.text,
        created_at: result.created_at,
      };
    } catch (error) {
      if (error instanceof ChannelNotFoundError) {
        // A CONSTANT message: echoing the id back would make the foreign-id
        // answer differ from the missing-id answer, and "different" is
        // itself a disclosure (FR-TEN-05).
        throw new NotFoundException("channel not found");
      }
      throw error;
    }
  }
}
