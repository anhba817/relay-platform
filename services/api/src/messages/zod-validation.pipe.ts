import type { PipeTransform } from "@nestjs/common";

import { protocolError } from "../protocol-error";
import type { ZodType } from "zod";

// Boundary validation (chapter 2.2). safeParse, never parse: a throw
// from deep inside a library is not an error shape anyone can rely on.
// The BadRequestException carries the message; 1.4's ProtocolErrorFilter
// turns it into the EIR-API-04 envelope on the way out — one error shape,
// one home, unchanged since the skeleton.
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      // WHICH FIELD, and chapter 3.14 is where that stopped being optional.
      //
      // EIR-API-04's error shape has carried a `field` since chapter 1.3 and
      // `errorFrameSchema` declares it — and nothing in the api had ever set it.
      // Every validation failure in twenty-two chapters said `Invalid input:
      // expected "public"` and left the caller to work out which key that was
      // about. This is the same habit as `request_id`, which was declared in 1.3
      // and first sent in 3.8: a field in the contract that the code never filled.
      //
      // Named here rather than in the filter because only the pipe knows the
      // path. Zod's `path` is an array — `["metadata", "blob"]` — and it joins
      // with dots, which is what a developer reading their own request body sees.
      // An empty path means the whole body failed (a non-object, say), and then
      // there is no field to name and the key is omitted rather than sent empty.
      /** A SCHEMA MAY NAME ITS OWN REFUSAL (chapter 3.24, FR-003a).
       *
       * Everything here is `invalid_request` and 400, which is right for a body the
       * contract does not allow. It is wrong for a field the contract DOES publish and
       * the platform cannot serve yet — `media_id` in FR-MSG-11 — where the caller made
       * no mistake and the honest answer is a code of its own.
       *
       * The alternative was a check in the controller, and it cannot work: this pipe runs
       * before the handler, so a media arm is already refused with a 400 by the time any
       * handler code could look. Whichever layer refuses first has to carry the code. */
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
