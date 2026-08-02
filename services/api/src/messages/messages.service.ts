import { Injectable, NotFoundException } from "@nestjs/common";

import {
  ChannelNotFoundError,
  Repository,
  type MessageRow,
} from "../db/repository";
import type { SendMessageBody } from "./messages.schema";

// The thin layer between HTTP and the repository (chapter 2.2). It owns
// exactly one thing today: turning the layer's domain error into the
// wire's 404 — same non-answer a foreign tenant's id has received since
// 2.1, now wearing an HTTP status. The filter from 1.4 shapes the body.
@Injectable()
export class MessagesService {
  constructor(private readonly repo: Repository) {}

  async send(channelId: string, body: SendMessageBody): Promise<MessageRow> {
    try {
      return await this.repo.sendMessage(channelId, body);
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
