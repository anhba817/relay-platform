import { z } from "zod";

import { messageDeletedPayloadSchema, messageSchema } from "./frames.js";

/** THE FIFTH SUBJECT GRAMMAR, and the argument for it is ADR-24.
 *
 * `chan:{channel_id}` carries a wire frame's payload — `fanout.ts:18` says so in its own
 * words — and that payload is a `Message`. Two things follow, and the second is fatal:
 *
 *   - An EDIT is a `Message` and could ride that subject by shape. But the receiver has no
 *     way to know it is an update: `session.ts` stamped `type: "message.created"` at the
 *     call site, so the kind was never on the fabric at all.
 *   - A DELETION is not a `Message`. It has no text, which is the same constraint that gave
 *     `message.deleted` its own frame payload. It cannot ride `chan:` even in principle.
 *
 * **A kind that cannot share a payload type cannot share a subject.** Three chapters reached
 * that independently — ADR-19 took `presence:{channel_id}`, ADR-20 took `member:{channel_id}`
 * and `member:{env}:{user}`, ADR-21 took `typing:{channel_id}` — which is why it is a rule
 * here rather than a preference.
 *
 * ONE SUBJECT FOR BOTH MUTATIONS, WITH A DISCRIMINATOR, following ADR-20 rather than taking
 * two subjects. That record's `membership.changed` carries `change: "added" | "removed"` for
 * the same reason: an edit and a deletion are two things that happen to one message, a
 * receiver subscribes to both or neither, and two subjects would double the subscription
 * bookkeeping for a distinction the payload already makes.
 *
 * NO `environment` FIELD, unlike `membershipFabricSchema` — and that is a decision rather
 * than an omission. Membership needs it because `member:{env}:{user}` names a user, which is
 * unique only within an environment. A channel id is a UUID and identifies its tenant
 * transitively, exactly as `chan:{channel_id}` has always relied on. */
export const REVISION_SUBJECT_PREFIX = "revision";

/** THE PREFIX IS EXPORTED BECAUSE A SUBSCRIBER HAS TO TELL TWO SUBJECTS APART.
 *
 * The gateway holds one Redis subscriber for both `chan:{channel_id}` and
 * `revision:{channel_id}`, so `subscriber.on("message")` has to route on the subject. A
 * literal `"revision:"` there would be a second place that knows this grammar, which is
 * the thing "a fabric owns its subject grammar" forbids. `internal.ts` set the precedent
 * with `EVENT_SUBJECT_PREFIX` and builds its subjects from it. */
export function subjectForChannelRevision(channelId: string): string {
  return `${REVISION_SUBJECT_PREFIX}:${channelId}`;
}

/** Does this subject belong to the revision fabric? The subscriber's routing question,
 * asked of the module that owns the answer. */
export function isChannelRevisionSubject(subject: string): boolean {
  return subject.startsWith(`${REVISION_SUBJECT_PREFIX}:`);
}

/** What crosses `revision:{channel_id}` between gateway instances. Consumed only by
 * gateways; each arm becomes the wire frame `frames.ts` already published.
 *
 * `discriminatedUnion`, so the two arms cannot be confused and an unknown `kind` is a
 * rejection rather than a silent pass. `strictObject` inside each arm for the reason
 * `membershipFabricSchema` gives: a field added on one side of a rolling deploy fails
 * loudly on the other instead of being dropped.
 *
 * THE WIRE FRAMES ARE NOT EDITED BY THIS FILE. `message.updated` carries a `Message` and
 * `message.deleted` carries an identity with no text; this schema is what gets them from
 * the api to a gateway that holds the socket. */
export const revisionFabricSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("updated"), message: messageSchema }),
  z.strictObject({ kind: z.literal("deleted"), message: messageDeletedPayloadSchema }),
]);

export type RevisionFabric = z.infer<typeof revisionFabricSchema>;
