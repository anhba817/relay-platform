import { z } from "zod";

import { forwardedMessageSchema, messageDeletedPayloadSchema } from "./frames.js";

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
 * **THE SUBJECT IS NAMED `revision:` AND CARRIES MORE THAN MESSAGE REVISIONS** (chapter
 * 4.14). Its contract is *something changed about what this channel's messages show* —
 * an edit, a deletion, or an attachment's media object reaching a terminal state. The
 * name is narrower than the contents and it stays: renaming a subject is a wire change
 * and a fence-chain change across every chapter that publishes this file. **A name that
 * has quietly widened is worse than one that has widened on the record**, so this is the
 * record.
 *
 * WHY THIS SUBJECT RATHER THAN A SIXTH GRAMMAR (ADR-33). ADR-19's rule is that a kind
 * which cannot share a payload type cannot share a subject, and ADR-20 admitted two
 * payload types onto one subject under a test this arm also passes: *a receiver
 * subscribes to both or neither*. `fanout.ts` already subscribes `chan:` and `revision:`
 * together under one reference count, calling them co-extensive by construction. And
 * ADR-25's threshold is per-channel SUBSCRIBEs exceeding six: a sixth grammar would have
 * sat exactly on the bound and spent the last of the headroom on a kind whose subscriber
 * set is identical to one that already exists.
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
  // `forwardedMessageSchema` AND NOT `messageSchema` (FR-018d). The arm above says a
  // field added on one side of a rolling deploy must fail loudly on the other, and that
  // is right about this schema's OWN fields — `kind` and `message` are the contract.
  // It is wrong about an attachment, which `fanout.ts:98` never reads and hands to a
  // socket untouched: a refusal there is `fanout.invalid_payload` and a dropped edit.
  z.strictObject({ kind: z.literal("updated"), message: forwardedMessageSchema }),
  z.strictObject({ kind: z.literal("deleted"), message: messageDeletedPayloadSchema }),
  // THE THIRD ARM CARRIES NO MESSAGE, WHICH IS THE PART EVERY READER HAS TO LEARN
  // (FR-MED-07). The other two are about a message; this one is about an OBJECT a
  // message references, so its channel is a field rather than `message.channel`. Eight
  // sites in production reached through `.message` for the subject, the routing key or
  // a log field before this arm existed.
  //
  // `state` IS TWO VALUES AND NOT THREE. The frame announces a transition OUT of
  // `pending`, so `pending` is a value the producer cannot emit; admitting it would be
  // a state nothing can reach, which is the argument `0018` made for refusing a fourth
  // value in the column.
  //
  // NO `reason`. A rejection's cause is a closed set of two and broadcasting it would
  // tell every subscriber that a member's upload failed a virus scan. FR-MED-06's three
  // refusals are already byte-identical for the same reason: a refusal that names its
  // cause reports a fact about somebody else.
  z.strictObject({
    kind: z.literal("media"),
    media_id: z.uuid(),
    channel: z.string().min(1),
    state: z.enum(["ready", "rejected"]),
  }),
]);

export type RevisionFabric = z.infer<typeof revisionFabricSchema>;

/** THE CHANNEL A REVISION IS ABOUT, ASKED OF THE MODULE THAT OWNS THE GRAMMAR.
 *
 * Before chapter 4.14 every arm carried a `message` and eight sites in two services
 * reached through `revision.message.channel` for the subject, the routing key or a log
 * field. The media arm has no message, so each of those was a place that had to learn a
 * third shape — and `REVISION_SUBJECT_PREFIX` is exported for exactly the reason this
 * function now exists: *a literal there would be a second place that knows this
 * grammar.* A per-arm `switch` repeated eight times is eight places that know it.
 *
 * The compiler keeps this honest: the `switch` is exhaustive over the union, so a fourth
 * arm is a type error here rather than a subject somebody forgot to derive. */
export function channelOfRevision(revision: RevisionFabric): string {
  switch (revision.kind) {
    case "updated":
    case "deleted":
      return revision.message.channel;
    case "media":
      return revision.channel;
  }
}

/** What a log line can say about any arm, since only two of the three have a message id.
 * `message_id` is absent rather than `undefined` for the media arm: a field that reads
 * `undefined` looks like a value the code failed to compute, and one that is missing
 * looks like what it is — inapplicable. */
export function logFieldsOfRevision(
  revision: RevisionFabric,
): { channel: string; kind: string; message_id?: string } {
  return revision.kind === "media"
    ? { channel: revision.channel, kind: revision.kind }
    : { channel: revision.message.channel, kind: revision.kind, message_id: revision.message.id };
}
