import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import { ZodValidationPipe } from "../messages/zod-validation.pipe";
import {
  listingQuerySchema,
  readPositionBodySchema,
  upsertUsersBodySchema,
  userProfileBodySchema,
  type ListingQuery,
  type ReadPositionBody,
  type UpsertUsersBody,
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

  /** Up to 100 users in one call (chapter 3.15, FR-025).
   *
   * DECLARED BEFORE THE `:externalId` ROUTES. Nest matches in declaration order and
   * `POST /v1/users` and `PATCH /v1/users/:externalId` differ in both method and segment
   * count, so nothing shadows anything here — but a bare-path route below a parameterised
   * one is the shape that eventually does, and the habit costs nothing.
   *
   * 200 AND NOT 201, because the array reports created, updated and revived per entry.
   * One status code for a mixed outcome would have to pick a lie. */
  @Post()
  @HttpCode(200)
  async upsertUsers(
    @Body(new ZodValidationPipe(upsertUsersBodySchema)) body: UpsertUsersBody,
  ) {
    return this.users.upsertUsers(body);
  }

  /** Delete a user, keeping their row and their messages (chapter 3.15, FR-027). */
  @Delete(":externalId")
  async deleteUser(@Param("externalId") externalId: string) {
    return this.users.deleteUser(externalId);
  }

  /** The ban pair (chapter 3.15, FR-031).
   *
   * TWO ROUTES ON ONE PATH RATHER THAN A `PATCH` WITH A BOOLEAN. `POST …/ban` and
   * `DELETE …/ban` say what they do in the method, and a customer's reconciliation loop
   * can issue either without reading the current state first. A `{"banned": false}` body
   * would be a second way to spell the same thing.
   *
   * `@HttpCode(200)` on the POST for the reason the upsert has it: nothing is created,
   * and banning an already-banned user is a 200 too. */
  @Post(":externalId/ban")
  @HttpCode(200)
  async ban(@Param("externalId") externalId: string) {
    return this.users.setBanned(externalId, true);
  }

  @Delete(":externalId/ban")
  async unban(@Param("externalId") externalId: string) {
    return this.users.setBanned(externalId, false);
  }
}
