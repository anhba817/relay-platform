import { z } from "zod";

// THE USER SURFACE'S BODIES AND QUERIES (chapter 3.15, FR-013, FR-016, FR-017).
//
// `strictObject` throughout, the same as `channels.schema.ts` and
// `messages.schema.ts`: constitution VI rejects unknown fields on a write endpoint,
// and `channels.itest.ts:118` is the assertion that keeps it honest. A caller who
// writes `Limit` instead of `limit` finds out on the first call.

/** FR-013's page bound: the same 100 as the member-add and the upsert.
 *
 * ONE NUMBER FOR THE CONCEPT, not three that happen to agree. A page of channels, a
 * batch of members and a batch of users are all "how much a customer's server may
 * ask for in one request", and three different ceilings would be three things to
 * remember. */
export const LISTING_LIMIT_MAX = 100;
const LISTING_LIMIT_DEFAULT = 25;

/** The cursor is opaque to the client and a keyset to us: base64 of the JSON pair
 * `(last_activity_at, id)`.
 *
 * DECODED HERE AND NOT IN THE SERVICE, because a malformed cursor is a validation
 * failure with `field: "cursor"` — the shape `ZodValidationPipe` already produces
 * (chapter 3.14 gave every validation error its field). Decoding it downstream would
 * make it a 500 or a hand-rolled 400 that names nothing.
 *
 * OPAQUE IS NOT SECURITY. Base64 of JSON is readable by anyone who wants to read it;
 * what opacity buys is that the pair is ours to change without breaking a client that
 * treated the string as a token. A client that decodes it and constructs its own is
 * outside the contract. */
const cursorPayload = z.strictObject({
  a: z.string().min(1),
  id: z.string().uuid(),
});

export function encodeCursor(activityAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ a: activityAt, id }), "utf8").toString(
    "base64url",
  );
}

export const listingQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LISTING_LIMIT_MAX)
    .default(LISTING_LIMIT_DEFAULT),
  cursor: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      } catch {
        ctx.addIssue({ code: "custom", message: "cursor is not a valid cursor" });
        return z.NEVER;
      }
      const shape = cursorPayload.safeParse(parsed);
      if (!shape.success) {
        ctx.addIssue({ code: "custom", message: "cursor is not a valid cursor" });
        return z.NEVER;
      }
      const activityAt = new Date(shape.data.a);
      if (Number.isNaN(activityAt.getTime())) {
        ctx.addIssue({ code: "custom", message: "cursor is not a valid cursor" });
        return z.NEVER;
      }
      return { activityAt, id: shape.data.id };
    }),
});

export type ListingQuery = z.infer<typeof listingQuerySchema>;
