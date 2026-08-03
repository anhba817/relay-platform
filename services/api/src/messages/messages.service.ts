import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  ChannelNotFoundError,
  Repository,
  type MessageRow,
} from "../db/repository";
import { decodeCursor, encodeCursor } from "./cursor";
import type { HistoryQuery, SendMessageBody } from "./messages.schema";

// The thin layer between HTTP and the repository (chapters 2.2 + 2.3). It
// owns two things: turning the layer's domain error into the wire's 404,
// and translating the repository's `duplicate: true` into FR-MSG-04's
// "201-equivalent semantics" — the retry returns the original message,
// indistinguishable from a fresh send (the `duplicate` flag stays internal).
@Injectable()
export class MessagesService {
  constructor(private readonly repo: Repository) {}

  async send(channelId: string, body: SendMessageBody): Promise<MessageRow> {
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

  /** A page of history (chapter 2.4). The cursor is opaque coming in and
   * going out; the service is the only place that knows it encodes a
   * sequence. A cursor we did not mint is a 400, never a silent reset to
   * the top — serving the wrong page quietly is worse than refusing. */
  async history(
    channelId: string,
    { cursor, direction, limit }: HistoryQuery,
  ): Promise<{
    messages: MessageRow[];
    next_cursor: string | null;
    prev_cursor: string | null;
  }> {
    let anchor: number | undefined;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor);
      if (decoded === null) throw new BadRequestException("malformed cursor");
      anchor = decoded;
    }
    const messages = await this.repo.listMessages(channelId, {
      limit,
      ...(direction === "newer"
        ? { afterSeq: anchor ?? 0 }
        : anchor === undefined
          ? {}
          : { beforeSeq: anchor }),
    });
    // Edge rows become the next anchors. A short page still yields a
    // next_cursor: "no more yet" and "no more ever" are the same answer
    // in a feed that keeps growing, and the client simply gets an empty
    // page next time.
    const first = messages[0];
    const last = messages[messages.length - 1];
    return {
      messages,
      next_cursor: last ? encodeCursor(last.seq) : null,
      prev_cursor: first ? encodeCursor(first.seq) : null,
    };
  }
}
