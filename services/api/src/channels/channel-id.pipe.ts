import { Injectable, NotFoundException, type PipeTransform } from "@nestjs/common";

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
 * Applied at the thirteen `@Param("channelId", ChannelIdPipe)` sites: seven in
 * `channels.controller.ts`, five under `messages.controller.ts`'s
 * `v1/channels/:channelId/messages` prefix, one on `users.controller.ts`'s read
 * position route.
 */
@Injectable()
export class ChannelIdPipe implements PipeTransform<string, Promise<string>> {
  constructor(private readonly repo: Repository) {}

  async transform(value: string): Promise<string> {
    const id = await this.repo.resolveChannelId(value);
    if (id === null) {
      // THE SAME REFUSAL THE HANDLERS ALREADY MAKE, word for word. A constant
      // message is `channels.service.ts`'s decision and FR-TEN-05's requirement:
      // a foreign channel and an absent one must answer identically, or the
      // difference is itself a disclosure. Echoing the segment back here would
      // undo that for every route at once.
      throw new NotFoundException("channel not found");
    }
    return id;
  }
}
