import { z } from "zod";

// THE PUBLIC CHANNEL SURFACE'S BODIES (FR-016, FR-CHN-01, FR-CHN-06, NFR-SEC-04).
//
// Both strict: an unknown field is a rejection, not a silently ignored typo. An
// integrating developer who writes `externalId` instead of `external_id` finds out
// on the first call rather than after wondering why the name never appears.

/** 8 KB, the same bound `channels.metadata` has had since chapter 2.1 — the
 * column is jsonb with a `{}` default, so this is a limit on what a caller may
 * send and not a new capability. Measured on the JSON text, because that is what
 * the column stores and what the row costs. */
const METADATA_BYTES = 8 * 1024;

const metadataSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= METADATA_BYTES, {
    message: `metadata must be at most ${METADATA_BYTES} bytes of JSON`,
  });

export const createChannelBodySchema = z.strictObject({
  external_id: z.string().min(1).max(255),
  // BOTH, AND ONLY NOW (chapter 3.15, FR-009).
  //
  // Chapter 3.12 pinned this enum to `public` alone with the sharpest edit in that
  // chapter, and the reason it gave was true then: `channels.type` had been a
  // `"public" | "private"` column with a CHECK since chapter 2.1 and NOTHING
  // DECIDED ON IT. An endpoint accepting `private` would have sold a guarantee the
  // platform did not keep.
  //
  // ONE SENTENCE IN THAT COMMENT WAS WRONG, and it shipped for three chapters:
  // "there is no membership check on any read path". `repository.backfill` joins
  // `members` on the caller's user id, and `session.controller` builds its channel
  // list from `channelsForUser` — both are read paths and both check membership.
  // What was true is narrower: the PUBLIC history and send routes checked nothing,
  // and `POST /internal/messages` resolved a user and checked nothing. Corrected
  // here under FR-037, in the same edit that widens the enum, because a false
  // sentence inside a titled fence cannot wait for a later phase.
  //
  // WIDENED LAST, DELIBERATELY. FR-009 gates this on FR-001 to FR-003 holding
  // first: the send path refuses a non-member, the by-id read and history answer
  // as if the channel were absent, and the socket's session never carries it. All
  // four are in place before this line changed. Reversed, the platform would sell
  // the guarantee before keeping it — which is the mistake chapter 3.12's fifth
  // analysis pass caught one phase before it shipped.
  type: z.enum(["public", "private"]),
  name: z.string().min(1).max(255).optional(),
  metadata: metadataSchema.optional(),
});

export type CreateChannelBody = z.infer<typeof createChannelBodySchema>;

/** FR-CHN-06's page: at most 100 users in one call. The channel's own ceiling is
 * 1,000 (FR-CHN-07) and is enforced in the service against a counted read — this
 * only bounds the size of a single request. */
/** FR-CHN-04's three, and NOT `memberships`' three (chapter 3.15, FR-011).
 *
 * `memberships.role` is `('owner','admin','member')` — a human's role in an
 * organisation, FR-TEN-07. This is a user's role in a CHANNEL. One word apart, and
 * the database CHECK names these three so a request that gets past this enum still
 * cannot write `admin`. */
export const CHANNEL_ROLES = ["owner", "moderator", "member"] as const;
export const channelRoleSchema = z.enum(CHANNEL_ROLES);
export type ChannelRole = z.infer<typeof channelRoleSchema>;

/** An entry in the add body: a bare external id, or an id with a role.
 *
 * A UNION RATHER THAN A NEW SHAPE, because chapter 3.13 shipped
 * `{"user_ids": ["a", "b"]}` and a customer's server is sending that today. FR-011b
 * asks that a member be creatable WITH a role — US6's first scenario — and the
 * cheapest honest way is for an entry to be either form:
 *
 *     {"user_ids": ["a", {"user": "b", "role": "owner"}]}
 *
 * `contracts/membership.md` proposed renaming the field to `users`, which would
 * have been a breaking change to a shipped route decided in an analysis pass. The
 * shipped name wins and the contract is corrected. */
export const addMemberEntrySchema = z.union([
  z.string().min(1).max(255),
  z.strictObject({
    user: z.string().min(1).max(255),
    role: channelRoleSchema.optional(),
  }),
]);

export const addMembersBodySchema = z.strictObject({
  user_ids: z.array(addMemberEntrySchema).min(1).max(100),
});

/** One entry, normalised. The union above is for the wire; nothing downstream should
 * have to ask which form arrived. */
export function normaliseEntry(
  entry: z.infer<typeof addMemberEntrySchema>,
): { user: string; role?: ChannelRole | undefined } {
  // `| undefined` explicitly, because `exactOptionalPropertyTypes` is on (ADR-15's
  // strictness, chapter 1.4): an optional property and a property that may hold
  // `undefined` are different types here, and the union's object arm produces the
  // second.
  return typeof entry === "string" ? { user: entry } : entry;
}

/** FR-006's page: at most 100 users in one removal, the same bound as the add.
 *
 * THE SAME NUMBER FOR THE SAME REASON, not by symmetry. Both routes take a list a
 * customer's server assembled, and a bound that differed between them would be two
 * numbers to remember for one concept. `strictObject`, so a misspelled key is a
 * refusal rather than a silently ignored typo. */
export const removeMembersBodySchema = z.strictObject({
  user_ids: z.array(z.string().min(1).max(255)).min(1).max(100),
});

export type AddMembersBody = z.infer<typeof addMembersBodySchema>;

/** FR-CHN-07. A structural limit on one channel, not a monthly quota — see
 * `channel_member_limit_exceeded` in the registry for why it is not
 * `quota_exceeded`. */
export const CHANNEL_MEMBER_LIMIT = 1000;

export type RemoveMembersBody = z.infer<typeof removeMembersBodySchema>;

/** The `PATCH` body for one member's role (chapter 3.15, FR-011).
 *
 * `strictObject` and a required `role`: a PATCH with an empty body would be a
 * request that asks for nothing, and answering it 200 would be a lie about having
 * changed something. */
export const setMemberRoleBodySchema = z.strictObject({
  role: channelRoleSchema,
});

export type SetMemberRoleBody = z.infer<typeof setMemberRoleBodySchema>;
