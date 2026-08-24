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
      const path = issue?.path.join(".");
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
