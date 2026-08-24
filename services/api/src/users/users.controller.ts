import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";
import {
  listingQuerySchema,
  readPositionBodySchema,
  userProfileBodySchema,
  type ListingQuery,
  type ReadPositionBody,
  type UserProfileBody,
} from "./users.schema";
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

  /** A read position for the user the path names (chapter 3.15, FR-017).
   *
   * `@Accepts("application", "user")` AT THE METHOD LEVEL, and it is the only route on
   * this controller that takes a user token: a user records their own position, and the
   * tenant records one on behalf of the user it names. Method-level wins over the
   * class-level `@Accepts("application")` because the guard resolves
   * `[handler, class]` in that order.
   *
   * `:channelId` IS THE UUID, like every other channel route in this API.
   * `contracts/listing.md` writes it `:channelExternalId`, and that file says of itself
   * that its paths are written with the customer's identifiers in place while the router
   * names channel parameters `:channelId` — a classification entry copied from it
   * verbatim will not match a derived target. */
  @Put(":externalId/channels/:channelId/read")
  @Accepts("application", "user")
  async setReadPosition(
    @Param("externalId") externalId: string,
    @Param("channelId") channelId: string,
    @Body(new ZodValidationPipe(readPositionBodySchema)) body: ReadPositionBody,
  ): Promise<{ sequence: number }> {
    return this.users.setReadPosition(externalId, channelId, body.sequence);
  }

  /** The profile, read and written (chapter 3.15, FR-023, FR-024).
   *
   * TWO OF ITS THREE FIELDS HAVE NEVER BEEN WRITTEN BY ANY ROUTE. `users.avatar_url` and
   * `users.metadata` have been in the schema since chapter 2.1 with no reference outside
   * tests. This pair of routes is what the feature's headline was about.
   *
   * `:externalId` LAST IN THE FILE AND NOT FIRST. Nest matches routes in declaration
   * order, so `GET :externalId` declared above `GET :externalId/channels` would still be
   * fine — the paths differ in segment count — but keeping the more specific route first
   * is the habit that stops the next route from shadowing something. */
  @Get(":externalId")
  async readProfile(@Param("externalId") externalId: string) {
    return this.users.readProfile(externalId);
  }

  @Patch(":externalId")
  async updateProfile(
    @Param("externalId") externalId: string,
    @Body(new ZodValidationPipe(userProfileBodySchema)) body: UserProfileBody,
  ) {
    return this.users.updateProfile(externalId, body);
  }
}
