import { BadRequestException, type PipeTransform } from "@nestjs/common";
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
      throw new BadRequestException(
        result.error.issues[0]?.message ?? "invalid body",
      );
    }
    return result.data;
  }
}
