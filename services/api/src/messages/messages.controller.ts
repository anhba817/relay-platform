import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { EnvironmentContextGuard } from "./environment-context.guard";
import { MessagesService } from "./messages.service";
import { historyQuerySchema, sendMessageBodySchema } from "./messages.schema";
// `import type` is required, not stylistic: with isolatedModules and
// emitDecoratorMetadata on (ADR-15's trade-off, chapter 1.4), a type used
// in a decorated signature must be imported as a type or TS1272 refuses
// to compile it.
import type { HistoryQuery, SendMessageBody } from "./messages.schema";
import { ZodValidationPipe } from "./zod-validation.pipe";

// The api's first product endpoint (chapter 2.2). Validation is zod at the
// boundary — the same schema family as @relay/protocol, so the REST body
// and the WebSocket frame payload cannot drift (1.3's payoff, again).
@Controller("v1/channels/:channelId/messages")
@UseGuards(EnvironmentContextGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post()
  async send(
    @Param("channelId") channelId: string,
    @Body(new ZodValidationPipe(sendMessageBodySchema)) body: SendMessageBody,
  ) {
    const message = await this.messages.send(channelId, body);
    // FR-MSG-04's "201-equivalent semantics" lives HERE, on the public
    // wire: the client sees the same body whether this was the original
    // send or the retry that recovered it. Moved down from the service in
    // chapter 2.6, where an internal caller turned out to need the flag.
    // The field list is spelled out rather than spread-minus-`duplicate`,
    // so a new column joins the public response only when someone decides
    // it should.
    return {
      id: message.id,
      channel_id: message.channel_id,
      seq: message.seq,
      text: message.text,
      created_at: message.created_at,
    };
  }

  @Get()
  async history(
    @Param("channelId") channelId: string,
    @Query(new ZodValidationPipe(historyQuerySchema)) query: HistoryQuery,
  ) {
    return this.messages.history(channelId, query);
  }
}
