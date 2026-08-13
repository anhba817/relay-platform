import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import { WebhooksService } from "./webhooks.service";
import type { CreateEndpointInput } from "./webhooks.service";

// The webhook management surface (chapter 3.5, FR-WHK-01 and FR-WHK-08).
//
// `Accepts("application")` and nothing else: configuring where a tenant's events
// are delivered is the tenant's software acting for itself, not an end user
// acting for themselves. An end-user token reaching this route would mean any
// logged-in person in a customer's product could redirect that customer's
// events, which is a very short sentence describing a very large incident.
@Controller("v1/webhooks")
@UseGuards(CredentialGuard)
@Accepts("application")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /** 201 with the secret — the only time it is ever returned. */
  @Post()
  create(@Body() body: CreateEndpointInput) {
    return this.webhooks.create(body);
  }

  @Get()
  list() {
    return this.webhooks.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.webhooks.get(id);
  }

  /** 200, not Nest's default 201: rotation replaces a secret on an endpoint that
   * already exists. A 201 would tell a client something was created and hand it
   * no location for it.
   *
   * Opens the 24-hour rotation window and returns the new secret once. The
   * outgoing secret keeps signing until the window closes, so a recipient
   * accepting either is correct throughout (contracts/webhooks.md §Rotation). */
  @Post(":id/rotate-secret")
  @HttpCode(200)
  rotateSecret(@Param("id") id: string) {
    return this.webhooks.rotateSecret(id);
  }

  @Post(":id/enable")
  @HttpCode(200)
  enable(@Param("id") id: string) {
    return this.webhooks.setEnabled(id, true);
  }

  @Post(":id/disable")
  @HttpCode(200)
  disable(@Param("id") id: string) {
    return this.webhooks.setEnabled(id, false);
  }

  /** SOFT delete. The endpoint stops receiving deliveries and disappears from
   * every read; the row survives because its dead letters must (FR-WHK-04). */
  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.webhooks.remove(id);
  }
}
