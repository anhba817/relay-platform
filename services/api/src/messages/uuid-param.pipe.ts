import { HttpStatus, type PipeTransform } from "@nestjs/common";
import { z } from "zod";

import { protocolError } from "../protocol-error";

/** Refuse a path parameter that cannot be a uuid, naming which one (058-3).
 *
 * A malformed uuid in a path reaches the driver, Postgres answers `invalid input
 * syntax for type uuid`, and `ProtocolErrorFilter` has no rung for it — a
 * caller-triggered 500. Gap 058-3 counted **sixteen** shipped routes with that
 * defect: thirteen taking `channelId`, three taking `messageId`, one `mediaId`
 * already validated at chapter 4.12. `ChannelIdPipe` closes the thirteen as a
 * side effect of never casting a value that cannot be a uuid; this closes the
 * last three, and the gap with them.
 *
 * NOT `ZodValidationPipe`, AND THE REASON IS ITS `field`. That pipe names the
 * field from the zod issue's `path`, which is empty for a scalar and then
 * omitted, so the reuse would answer 400 without saying which parameter was
 * wrong. `media.controller.ts` made the same call for `mediaId` and wrote the
 * check inline; three sites is where inline stops paying, so the parameter's
 * name is a constructor argument instead.
 *
 * CONSTRUCTED, NOT INJECTED — `new UuidParamPipe("messageId")`, which is
 * `ZodValidationPipe`'s house style at twenty-one call sites. It needs nothing
 * from the injector, unlike `ChannelIdPipe`, whose whole point is the
 * request-scoped `Repository`.
 *
 * Called by the three `@Param("messageId", …)` sites in `messages.controller.ts`.
 */
export class UuidParamPipe implements PipeTransform<string, string> {
  constructor(private readonly field: string) {}

  transform(value: string): string {
    if (!z.uuid().safeParse(value).success) {
      throw protocolError(
        "invalid_request",
        `${this.field} must be a uuid`,
        HttpStatus.BAD_REQUEST,
        this.field,
      );
    }
    return value;
  }
}
