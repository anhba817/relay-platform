import { randomUUID } from "node:crypto";

import { Injectable, type PipeTransform } from "@nestjs/common";

import { Repository } from "../db/repository";

/** Resolve `:channelId` to a key, whichever space the caller named it in (FR-CHN-11).
 *
 * FR-USR-01 says Relay shall not generate end-user identities and ADR-18 says an
 * end user's identity is whatever `external_id` the customer already had for them.
 * ADR-38 carries that from users to channels: the customer's string is the
 * IDENTITY and the uuid is a KEY, and only one of them belongs on the wire. Until
 * this chapter, thirteen routes beneath `/v1/channels/:channelId` took the key and
 * nothing else, so a customer had to store a uuid to post to a channel they named
 * — the lookup table FR-CHN-01 exists to remove.
 *
 * ## A PIPE, BECAUSE MIDDLEWARE RUNS BEFORE GUARDS
 *
 * The cheapest design is one middleware registration in `app.module.ts`, and Nest
 * runs middleware BEFORE guards — so it has no principal, and a resolution with no
 * environment is a cross-tenant read. That is a correctness refusal rather than a
 * preference. Pipes run after guards, so by the time this executes
 * `CredentialGuard` has put the principal on the request and the request-scoped
 * `Repository` is constructed with its `environment_id`.
 *
 * ## THE SCOPE COMES FROM THE CONSTRUCTOR, NOT FROM A PREDICATE SOMEBODY WROTE
 *
 * `Repository`'s constructor requires an `environment_id`, which is the mechanism
 * chapter 4.21 found had kept six of seven stores correct without anyone
 * remembering. Measured before the design was committed: the same identifier
 * resolves under its own environment and resolves to nothing under a foreign one,
 * and the probe that asserts it goes red when the environment is swapped.
 *
 * ## THIS CLASS IS NOT A PROVIDER, AND THAT WAS MEASURED
 *
 * Three apps booted, one request each: with the pipe in `providers` and without
 * it, the request answers identically; with its DEPENDENCY removed, Nest refuses
 * by name. **Nest instantiates a param-level pipe from the module's injector
 * without it being registered** — what must be resolvable is `Repository`, which
 * is already a provider in `channels.module.ts`, `messages.module.ts` and
 * `users.module.ts`. An analysis pass reasoned the opposite from the
 * module-visibility rule `internal.module.ts` states, and prescribed three module
 * edits that do nothing. That rule is real and it governs dependencies, not
 * enhancers.
 *
 * ## IT RESOLVES AND IT NEVER REFUSES, AND THE GAUNTLET IS WHY
 *
 * The first version threw `NotFoundException("channel not found")` when nothing
 * resolved — the same refusal every handler makes, which looked exactly right and
 * was a disclosure. **A pipe runs before the handler, so it answers before every
 * check the handler makes**, and two of those checks come first on purpose:
 *
 *     a BANNED user, real channel        403 user_banned      the ban check
 *     a BANNED user, invented channel    404 not_found        this pipe
 *
 * `gauntlet.itest.ts` asserts those two are byte-identical once `request_id` is
 * stripped — *a banned user gets one answer for every channel id* — and with the
 * throwing pipe a banned user could tell a real channel from one that does not
 * exist. `messages.itest.ts` caught the same shape one check over: a token for a
 * user with no row answers `400 unknown user` before the channel is read, so a
 * refusing pipe made an absent channel answer 404 where a present one answered
 * 400, and the pair stopped matching.
 *
 * So an unresolved segment becomes **a uuid that names nothing** and the handler
 * refuses in its own order, exactly as it does today for a caller who passes a
 * uuid nobody has. Every ordering in all thirteen routes is the one that shipped;
 * the only thing this pipe changes is which strings can reach it.
 *
 * A FRESH RANDOM UUID RATHER THAN A FIXED SENTINEL. A nil uuid is a value a row
 * could in principle hold; `randomUUID()` cannot collide with anything, and it
 * makes the claim exact — an identifier that names nothing behaves like a uuid
 * that names nothing, because downstream it IS one.
 *
 * Applied at the thirteen `@Param("channelId", ChannelIdPipe)` sites: seven in
 * `channels.controller.ts`, five under `messages.controller.ts`'s
 * `v1/channels/:channelId/messages` prefix, one on `users.controller.ts`'s read
 * position route.
 */
@Injectable()
export class ChannelIdPipe implements PipeTransform<string, Promise<string>> {
  constructor(private readonly repo: Repository) {}

  async transform(value: string): Promise<string> {
    return (await this.repo.resolveChannelId(value)) ?? randomUUID();
  }
}
