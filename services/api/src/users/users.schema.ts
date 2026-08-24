import { z } from "zod";

// THE USER SURFACE'S BODIES AND QUERIES (chapter 3.15, FR-013, FR-016, FR-017).
//
// `strictObject` throughout, the same as `channels.schema.ts` and
// `messages.schema.ts`: constitution VI rejects unknown fields on a write endpoint,
// and `channels.itest.ts:118` is the assertion that keeps it honest. A caller who
// writes `Limit` instead of `limit` finds out on the first call.

/** 4 KB, and FR-USR-03 names that number the way FR-CHN-01 names 8 KB for a channel
 * (chapter 3.15, FR-024). Two bounds, half an order of magnitude apart, and the SRS chose
 * both — but "the SRS says so" is not a reason, so here is the one that holds.
 *
 * **THE BOUND TRACKS ROW CARDINALITY.** Measured on the test lane: 94,144 users against
 * 27,337 channels, and a user belongs to 1 channel on average while a channel holds 10
 * users. Users outnumber channels 3.4:1 here and the ratio only grows — a channel is a
 * conversation a customer creates deliberately, a user row appears for every end user who
 * ever authenticates, implicitly (FR-USR-02). At a million end users, 4 KB each is 4 GB of
 * jsonb that every profile read walks past.
 *
 * The channel's 8 KB buys something the user's does not: channel metadata is where a
 * customer puts routing and configuration for a shared object, read once per conversation.
 * A user's metadata is per-person annotation. Different multipliers, different budgets.
 *
 * Measured on the JSON text, like the channels bound, because that is what the column
 * stores and what the row costs. */
export const USER_METADATA_BYTES = 4 * 1024;

const userMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= USER_METADATA_BYTES,
    { message: `metadata must be at most ${USER_METADATA_BYTES} bytes of JSON` },
  );

/** The profile body (chapter 3.15, FR-023, FR-024).
 *
 * A PATCH, so every field is optional — and `strictObject`, so a misspelled one is a
 * refusal. An empty body is accepted and changes nothing: unlike the member-role PATCH,
 * which carries exactly one required field, a profile PATCH with no fields is a coherent
 * request that asks for the current state, and the response is the profile.
 *
 * `avatar_url` IS VALIDATED AS A URL AND NOT AS A STRING. The column has existed since
 * chapter 2.1 with nothing writing it, so this is the first thing that ever decides what
 * belongs in it, and the decision is worth making now rather than after a customer has
 * stored `"none"` in a million rows. `z.url()` refuses a relative path; the field's own
 * name promises a URL.
 *
 * `null` CLEARS, and it is distinct from absent. `{"display_name": null}` removes the
 * name; `{}` leaves it. Both columns are nullable, so the API can express the difference
 * and a PATCH that could only set would leave a customer unable to undo one. */
export const userProfileBodySchema = z.strictObject({
  display_name: z.string().min(1).max(255).nullable().optional(),
  avatar_url: z.string().url().max(2048).nullable().optional(),
  metadata: userMetadataSchema.optional(),
});

export type UserProfileBody = z.infer<typeof userProfileBodySchema>;

/** An entry in the bulk upsert (chapter 3.15, FR-025, FR-026).
 *
 * THE PROFILE FIELDS, NOT JUST AN ID. FR-026 says an entry naming an existing user
 * **updates** it, so the entry carries what there is to update. An entry that was only an
 * external id could not distinguish "create this user" from "update nothing about them".
 *
 * `strictObject`, and the same 4 KB metadata bound and URL validation the single PATCH
 * uses — one schema fragment, so the two routes cannot drift into accepting different
 * things for the same column. */
export const upsertUserEntrySchema = z.strictObject({
  external_id: z.string().min(1).max(255),
  display_name: z.string().min(1).max(255).nullable().optional(),
  avatar_url: z.string().url().max(2048).nullable().optional(),
  metadata: userMetadataSchema.optional(),
});

/** FR-025's bound: 100 in one request, and `field: "users"` on 101.
 *
 * THE SAME 100 AS THE MEMBER-ADD AND THE REMOVAL, for the same reason: all three are "how
 * much a customer's server may hand over in one call", and three different ceilings would
 * be three numbers to remember for one idea.
 *
 * THE FIELD IS `users` AND THE CHANNEL ROUTES' IS `user_ids`, which is a real
 * inconsistency and the shipped name wins on the routes that shipped. This route is new,
 * so it takes the name that describes what it carries — these are whole user records, not
 * a list of ids. */
export const upsertUsersBodySchema = z.strictObject({
  users: z.array(upsertUserEntrySchema).min(1).max(100),
});

export type UpsertUsersBody = z.infer<typeof upsertUsersBodySchema>;
export type UpsertUserEntry = z.infer<typeof upsertUserEntrySchema>;

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

/** The read-position body (chapter 3.15, FR-017).
 *
 * `strictObject` and a required non-negative integer. Zero is legal and means "I have
 * read nothing", which is also what a missing row means — a client that wants to reset
 * writes 0 rather than deleting anything. */
export const readPositionBodySchema = z.strictObject({
  sequence: z.number().int().min(0),
});

export type ReadPositionBody = z.infer<typeof readPositionBodySchema>;
