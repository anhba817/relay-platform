import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";

import { ALL_CHANNELS } from "@relay/protocol";

import { Accepts, CredentialGuard } from "../auth/credential.guard";
import type { RequestWithPrincipal } from "../auth/principal";
import {
  MEMBERSHIP_PUBLISHER,
  type MembershipPublisher,
} from "../membership/publisher";
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
  constructor(
    private readonly users: UsersService,
    // Chapter 3.20. The controller for the reason `channels.controller.ts` states:
    // `UsersService` holds neither a request id nor a logger, and FR-015's failure
    // line needs both.
    @Inject(MEMBERSHIP_PUBLISHER)
    private readonly membership: MembershipPublisher,
  ) {}

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
  @HttpCode(HttpStatus.OK)
  async ban(@Param("externalId") externalId: string, @Req() req: RequestWithPrincipal) {
    const { external_id, banned, revoked } = await this.users.setBanned(
      externalId,
      true,
    );
    // ONE PUBLISH FOR THE USER, not one per channel. The subject is the principal's
    // own — `member:{env}:{user}` — because there is no channel subject to use when
    // the change is "every channel", and because the gateway is the only place that
    // knows which of them a given connection holds.
    //
    // `revoked` empty means nothing changed, so a repeated ban publishes nothing
    // (FR-005). `ALL_CHANNELS` is the one spelling of the sentinel, and it never
    // reaches a client: the gateway expands it per channel
    // (`specs/038-chapter-3-20/contracts/membership-fabric.md`).
    if (revoked.length > 0) {
      await this.membership.publish({
        environment: req.principal?.environmentId ?? "unknown",
        channel: ALL_CHANNELS,
        user: externalId,
        change: "removed",
      });
    }
    return { external_id, banned };
  }

  /** THE UNBAN PUBLISHES NOTHING, and that is a decision rather than an omission.
   *
   * A ban leaves the `members` rows alone — it sets `users.banned_at` — so an
   * unbanned user's memberships are exactly what they were. What the ban destroyed
   * is the live connection's `channelIds`, and restoring that needs the channel list
   * the api would have to re-derive plus an `added` frame per channel, which is the
   * per-channel shape this contract rules out.
   *
   * Two things already repair it, and the phase that adds the second says so:
   * reconnecting reads membership at the door (chapter 3.2), and the backstop's
   * periodic re-read picks it up within its interval. Both are the mechanism this
   * chapter already builds; a third would be a special case for the rarer half of a
   * rare pair. `chapter-notes.md` records the choice. */
  @Delete(":externalId/ban")
  @HttpCode(HttpStatus.OK)
  async unban(@Param("externalId") externalId: string) {
    // The two fields the route has always answered with, named rather than
    // destructured away: this config does not treat a leading underscore as
    // "deliberately unused", so `const { revoked: _x, ...rest }` is a lint error.
    const { external_id, banned } = await this.users.setBanned(externalId, false);
    return { external_id, banned };
  }
}
