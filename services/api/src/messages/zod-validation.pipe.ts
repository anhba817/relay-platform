import type { PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

import { protocolError } from "../protocol-error";

// Boundary validation (chapter 2.2). safeParse, never parse: a throw
// from deep inside a library is not an error shape anyone can rely on.
//
// THROUGH `protocolError` AND NOT `BadRequestException`, and that switch is owed to the
// errors chapter rather than to this one. That chapter built the typed thrower and
// rewired `session.ts` and the filter to it; this pipe kept the untyped exception, and
// nothing noticed because both produce the same 400 envelope. What forced it here was a
// schema that needed a status other than 400 — the media arm, which refused with its own
// 422 from 3.24 until §4.14 made it accept. 1.4's ProtocolErrorFilter still turns the
// throw into the EIR-API-04 envelope on the way out — one error shape, one home,
// unchanged since the skeleton.
//
// WHAT THE MECHANISM IS FOR, WHICH IS NOT THE SAME AS WHO USED IT. The `protocolCode`
// branch below lets a SCHEMA name a refusal the pipe would otherwise call
// `invalid_request` with a 400. That is the right answer whenever a field is published
// in the contract and the caller made no mistake, and it is the only way to say so from
// a schema: `@Body(new ZodValidationPipe(...))` runs before the handler, so a controller
// check cannot reach the decision.
//
// NOTHING USES IT TODAY, SAID PLAINLY RATHER THAN LEFT TO BE DISCOVERED. Its one
// producer was `attachments.ts`'s `params: { protocolCode: "media_not_available" }`,
// removed by the chapter that made the arm accept. `grep -rn protocolCode` across
// `packages/` and `services/` finds this file and nothing else.
//
// KEPT, AND THE PRECEDENT CUTS BOTH WAYS. 4.10 added a `service_unavailable` rung to the
// error filter with nothing throwing it, on the grounds that a general extension point
// with a stated role outlives its last caller. 4.6 went the other way and reached
// 100/100/100/100 on `metering.ts` by DELETING two arms — and 044's rule is that a design
// in which a case cannot arise beats a branch that handles it, *because the branch is the
// thing that rots*. What decides it here is that this arm is one `params:` key from
// reachable, where `metering.ts`'s were unreachable by construction. The cost of keeping
// it is stated too: this file carries no coverage pin, so nothing reports the arm as
// uncovered either way.
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      // WHICH FIELD, and the public channel endpoints are where that stopped being optional.
      //
      // EIR-API-04's error shape has carried a `field` since chapter 1.3 and
      // `errorFrameSchema` declares it — and nothing in the api had ever set it.
      // Every validation failure in twenty-two chapters said `Invalid input:
      // expected "public"` and left the caller to work out which key that was
      // about. This is the same habit as `request_id`, which was declared in 1.3
      // and first sent by the rate limiter: a field in the contract that the code never filled.
      //
      // Named here rather than in the filter because only the pipe knows the
      // path. Zod's `path` is an array — `["metadata", "blob"]` — and it joins
      // with dots, which is what a developer reading their own request body sees.
      // An empty path means the whole body failed (a non-object, say), and then
      // there is no field to name and the key is omitted rather than sent empty.
      /** A SCHEMA MAY NAME ITS OWN REFUSAL — the mechanism, with no current user.
       *
       * Everything else here is `invalid_request` and 400, which is right for a body the
       * contract does not allow. It is wrong for a field the contract DOES publish, where
       * the caller made no mistake and the honest answer is a code of its own.
       *
       * The alternative is a check in the controller and it cannot work: this pipe runs
       * before the handler, so a schema refusal has already become a 400 by the time any
       * handler code could look. Whichever layer refuses first has to carry the code.
       *
       * The header of this file records who used it, why nothing does now, and the two
       * precedents that disagree about whether it should still be here. */
      // `params` IS ON THE ISSUE AT RUNTIME AND NOT ON ITS TYPE. Measured against the
      // pinned zod 4.4.3: a `refine` with `params` produces an issue whose keys are
      // `code, path, params, message`, and `$ZodIssue` declares only the first, third
      // and fourth. Narrowed through `unknown` rather than asserted, so a zod upgrade
      // that drops the field is a silent no-op here rather than a runtime throw.
      const named =
        issue !== undefined && typeof issue === "object" && "params" in issue
          ? ((issue as { params?: unknown }).params as
              | { protocolCode?: string; status?: number }
              | undefined)
          : undefined;
      const path = issue?.path.join(".");
      if (named?.protocolCode !== undefined) {
        throw protocolError(
          named.protocolCode as Parameters<typeof protocolError>[0],
          issue?.message ?? "refused",
          named.status ?? 400,
          ...(path !== undefined && path.length > 0 ? ([path] as const) : ([] as const)),
        );
      }
      throw protocolError(
        "invalid_request",
        issue?.message ?? "invalid body",
        400,
        path !== undefined && path.length > 0 ? path : undefined,
      );
    }
    return result.data;
  }
}
