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
  // `public` AND NOTHING ELSE, and this is the chapter's sharpest edit (FR-047).
  //
  // `channels.type` has been a `"public" | "private"` column with a CHECK
  // constraint since chapter 2.1, and NOTHING IN THE PLATFORM READS IT. History
  // and send scope by `environment_id` alone; there is no membership check on any
  // read path. So FR-CHN-05 — a P1 clause promising that a private channel is
  // visible only to its members — is unimplemented.
  //
  // An endpoint accepting `private` would sell a guarantee the platform does not
  // keep, and it would do it in the chapter whose exit criterion is that an
  // outsider can integrate on the documentation alone. The enum is `public`
  // today; FR-CHN-03's private half goes to chapter 3.15 with FR-CHN-05, where
  // the read paths are made to honour it.
  type: z.enum(["public"]),
  name: z.string().min(1).max(255).optional(),
  metadata: metadataSchema.optional(),
});

export type CreateChannelBody = z.infer<typeof createChannelBodySchema>;

/** FR-CHN-06's page: at most 100 users in one call. The channel's own ceiling is
 * 1,000 (FR-CHN-07) and is enforced in the service against a counted read — this
 * only bounds the size of a single request. */
export const addMembersBodySchema = z.strictObject({
  user_ids: z.array(z.string().min(1).max(255)).min(1).max(100),
});

export type AddMembersBody = z.infer<typeof addMembersBodySchema>;

/** FR-CHN-07. A structural limit on one channel, not a monthly quota — see
 * `channel_member_limit_exceeded` in the registry for why it is not
 * `quota_exceeded`. */
export const CHANNEL_MEMBER_LIMIT = 1000;
