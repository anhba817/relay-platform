import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";

import { EnvironmentContextGuard } from "./environment-context.guard";
import { MessagesService } from "./messages.service";
import { sendMessageBodySchema } from "./messages.schema";
// `import type` is required, not stylistic: with isolatedModules and
// emitDecoratorMetadata on (ADR-15's trade-off, chapter 1.4), a type used
// in a decorated signature must be imported as a type or TS1272 refuses
// to compile it.
import type { SendMessageBody } from "./messages.schema";
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
    return this.messages.send(channelId, body);
  }
}
