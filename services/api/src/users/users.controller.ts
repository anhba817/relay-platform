import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";
import { listingQuerySchema, type ListingQuery } from "./users.schema";
import { UsersService } from "./users.service";

/** The user surface (chapter 3.15).
 *
 * `@Accepts("application")` AT THE CLASS LEVEL. Every route here is the tenant
 * acting on a user it names in the path — a customer's server listing a user's
 * channels, reading their profile, upserting them, banning them. A user token on
 * these routes would be a user acting on themselves through a path that says who
 * they are, which is a different route shape and not one the SRS asks for.
 *
 * Declared rather than defaulted, because chapter 3.15 found the cost of leaving it
 * out: `MessagesController` declared no `@Accepts`, the guard fell back to accepting
 * either class, and the membership check behind it was gated on a user id the public
 * route never supplied. */
@Controller("v1/users")
@UseGuards(CredentialGuard)
@Accepts("application")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(":externalId/channels")
  async listChannels(
    @Param("externalId") externalId: string,
    @Query(new ZodValidationPipe(listingQuerySchema)) query: ListingQuery,
  ): Promise<{ data: Array<Record<string, unknown>>; next_cursor: string | null }> {
    return this.users.listChannels(externalId, query);
  }
}
