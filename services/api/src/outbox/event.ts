import { attachmentSchema, type Attachment } from "@relay/protocol";

import { subjectFor } from "@relay/protocol";
import { z } from "zod";

// The event envelope (chapter 3.3). Built in ONE place, complete, inside the
// transaction that caused it — so the relay is a mover of bytes and never an
// author of them (ADR-04, research R7).
//
// Nothing in this file reads the clock or generates an id. Both arrive from the
// caller, which is what makes a republished event byte-identical to its first
// attempt: the deduplication key a consumer sees after a crash is the same key
// it would have seen without one.

/** A message as the PUBLIC api returns it. Consumers are customers: they get
 * external ids and the field names the REST surface uses. `user_id` does not
 * cross this boundary. */
export interface MessageCreatedData {
  id: string;
  channel_id: string;
  seq: number;
  user: string | null;
  text: string | null;
  /** Chapter 3.24 (FR-015, FR-017). ON `message.created` AND `message.updated` AT ONCE,
   * because both events carry this one interface — FR-015 asks that a consumer need one
   * shape for both, and the type is where that stops being a promise.
   *
   * AND ON NEITHER `message.deleted` NOR THE MEMBERSHIP EVENTS. `MessageDeletedData`
   * below carries no `text` because a payload with a text field can carry the words
   * somebody asked to have removed; an attachment URL is exactly as recoverable, so the
   * absence there is the same decision and not an omission.
   *
   * NOT OPTIONAL. `consumer/runtime.ts` answers a failed parse with `message.term()`,
   * which stops redelivery for good — so a branch that has not been widened is a row
   * destroyed rather than retried, and an optional field hides the day that happens. */
  attachments: Attachment[];
  created_at: string;
}

/** A DELETION as a consumer receives it (chapter 3.23, FR-019, FR-020).
 *
 * NO `text`, AND NO `text: null` EITHER. The frame `packages/protocol/src/frames.ts`
 * publishes made the same choice for the same reason: a deletion whose payload has a
 * text field is a payload that can carry the words somebody asked to have removed, and
 * `null` is a value somebody can forget to set. FR-020 says the event must not carry
 * it, and the way to guarantee that is for the type not to have the key.
 *
 * `user` IS THE AUTHOR, NOT THE DELETER, and nullable for the reason `MessageCreatedData`
 * gives: a message can have no sender. Who removed it lives on the row, as
 * `metadata.deleted_by` (FR-006a), and is deliberately not on this envelope — a
 * customer's webhook subscription is about what happened to the message. */
export interface MessageDeletedData {
  id: string;
  channel_id: string;
  seq: number;
  user: string | null;
  deleted_at: string;
}

/** A membership change as a CONSUMER receives it (chapter 3.20, FR-WHK-02).
 *
 * `user` IS THE EXTERNAL ID and the type says so, because the repository methods
 * that build this event hold only `users.id`. `MessageCreatedData` above fixes the
 * boundary — "Consumers are customers: they get external ids and the field names the
 * REST surface uses. `user_id` does not cross this boundary" — and the message path
 * honours it by having its caller pass `userExternalId` down. The membership paths
 * do the same, for the same reason: building the event outside the transaction to
 * get at an external id is the constitution II violation this chapter's phase order
 * exists to prevent. */
export interface MembershipChangedData {
  channel_id: string;
  /** The EXTERNAL id. Never `users.id`. */
  user: string;
}

/** FR-WHK-02 names eight event types and one existed before this chapter. These are
 * the second and third, spelled as that clause spells them — a customer's webhook
 * subscription filters on these strings, so the spelling is the requirement's and not
 * this chapter's.
 *
 * WIDENED FROM A LITERAL. `type` was `"message.created"` alone, which is the shape a
 * consumer narrows on: every `switch` and every `===` against it sees this change,
 * which is what a typecheck catches and an integration lane does not. */
/** THE ARRAY IS THE SOURCE AND THE TYPE IS DERIVED, so the set has a size a test can
 * read. A bare union has no runtime form: "the union has exactly three members" is
 * unassertable, and chapter 3.19's `codes.test.ts` earned its keep precisely by
 * asserting an exact set and an exact count — which is what makes a new member a
 * decision rather than an accident. `as const` plus `(typeof …)[number]` costs one
 * line and buys that. */
export const OUTBOX_EVENT_TYPES = [
  "message.created",
  // CHAPTER 3.23's TWO, spelled as FR-WHK-02 spells them because a customer's
  // subscription filters on these exact strings.
  //
  // BROUGHT FORWARD FROM PHASE 9, and the reason is ADR-06 rather than convenience.
  // `repository.deleteMessage` writes its event INSIDE the transaction that writes the
  // tombstone — publishing after the commit leaves a window where the row changed and
  // the event never existed — so the envelope cannot arrive three phases after the
  // transaction that has to build it. FR-009's "no second event" is also unassertable
  // without it: two 204s prove nothing, and the outbox row is what carries the
  // requirement. `baseline.txt` records the ordering defect.
  "message.updated",
  "message.deleted",
  "channel.member_added",
  "channel.member_removed",
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export interface OutboxEvent {
  /** UUID, generated in the transaction. The consumer's deduplication key. */
  id: string;
  /** FR-WHK-02's name for this event, spelled as that requirement spells it. */
  type: OutboxEventType;
  environment_id: string;
  /** When the state change happened — the message's own timestamp, not the
   * moment this object was constructed. */
  occurred_at: string;
  data: MessageCreatedData | MessageDeletedData | MembershipChangedData;
}

export interface PendingEvent {
  subject: string;
  payload: OutboxEvent;
}

// The subject grammar moved to @relay/protocol in chapter 3.4, because a
// consumer needs it too and both sides must agree on it. Imported for use
// below and re-exported so 3.3's callers keep working.
export { subjectFor };

export function messageCreatedEvent({
  eventId,
  environmentId,
  message,
}: {
  eventId: string;
  environmentId: string;
  message: MessageCreatedData;
}): PendingEvent {
  // Refused rather than defaulted. An event with no deduplication key looks
  // deliverable and cannot be deduplicated, which is worse than no event.
  if (!eventId) throw new Error("an event id is required");
  if (!environmentId) throw new Error("an environment id is required");

  return {
    subject: subjectFor("message.created", environmentId),
    payload: {
      id: eventId,
      type: "message.created",
      environment_id: environmentId,
      occurred_at: message.created_at,
      data: message,
    },
  };
}

/** An edit, built inside the transaction that wrote it (chapter 3.23, FR-019).
 *
 * THE SAME `MessageCreatedData` PAYLOAD, which is FR-008a as code: *"The message payload
 * used by creation and edit events MUST be left unchanged."* An edited message is a
 * message — same fields, `text` now saying something else — and a consumer that already
 * handles `message.created` needs no new shape to handle this, only a new type to switch
 * on.
 *
 * `occurred_at` IS THE EDIT'S INSTANT, not the message's `created_at`. That is the one
 * place this diverges from the creation event, and it has to: an event whose
 * `occurred_at` predates the previous event about the same message is unorderable by a
 * consumer. It arrives from the caller like every other clock reading in this file. */
export function messageUpdatedEvent({
  eventId,
  environmentId,
  occurredAt,
  message,
}: {
  eventId: string;
  environmentId: string;
  occurredAt: string;
  message: MessageCreatedData;
}): PendingEvent {
  if (!eventId) throw new Error("an event id is required");
  if (!environmentId) throw new Error("an environment id is required");

  return {
    subject: subjectFor("message.updated", environmentId),
    payload: {
      id: eventId,
      type: "message.updated",
      environment_id: environmentId,
      occurred_at: occurredAt,
      data: message,
    },
  };
}

/** A deletion, built inside the transaction that wrote the tombstone (chapter 3.23,
 * FR-019, FR-020).
 *
 * ITS OWN PAYLOAD TYPE, and `MessageDeletedData`'s docstring argues why the text is
 * absent rather than null. This function cannot put a text on the wire because it has
 * nowhere to put one, which is a stronger guarantee than a reviewer remembering. */
export function messageDeletedEvent({
  eventId,
  environmentId,
  occurredAt,
  message,
}: {
  eventId: string;
  environmentId: string;
  occurredAt: string;
  message: MessageDeletedData;
}): PendingEvent {
  if (!eventId) throw new Error("an event id is required");
  if (!environmentId) throw new Error("an environment id is required");

  return {
    subject: subjectFor("message.deleted", environmentId),
    payload: {
      id: eventId,
      type: "message.deleted",
      environment_id: environmentId,
      occurred_at: occurredAt,
      data: message,
    },
  };
}

/** A membership change, built inside the transaction that wrote the row.
 *
 * `occurred_at` ARRIVES FROM THE CALLER, like `messageCreatedEvent`'s, and for the
 * same reason: a republished event must be byte-identical to its first attempt, so
 * nothing here reads the clock.
 *
 * THE CHANGE'S DIRECTION IS THE TYPE, not a field. FR-WHK-02 spells two separate
 * event names rather than one with an `added`/`removed` discriminator, because that
 * is what a customer subscribes to — an endpoint wanting only removals selects
 * `channel.member_removed` and receives nothing else. The wire frame this chapter
 * also produces does carry a `change` field, and the two shapes differ for that
 * reason rather than by accident (see `specs/038-chapter-3-20/data-model.md` §2). */
export function membershipEvent({
  eventId,
  environmentId,
  change,
  occurredAt,
  membership,
}: {
  eventId: string;
  environmentId: string;
  change: "added" | "removed";
  occurredAt: string;
  membership: MembershipChangedData;
}): PendingEvent {
  // Refused rather than defaulted, exactly as above.
  if (!eventId) throw new Error("an event id is required");
  if (!environmentId) throw new Error("an environment id is required");
  // AND THE EXTERNAL ID IS REFUSED WHEN ABSENT. The two ids above are refused
  // because a defaulted one is undetectable; this one because an internal uuid
  // reaching a customer's webhook is undetectable too, and the type alone cannot
  // stop `String(user.id)` being passed.
  if (!membership.user) throw new Error("a user external id is required");

  const type =
    change === "added" ? "channel.member_added" : "channel.member_removed";
  return {
    subject: subjectFor(type, environmentId),
    payload: {
      id: eventId,
      type,
      environment_id: environmentId,
      occurred_at: occurredAt,
      data: membership,
    },
  };
}

/** The envelope as a CONSUMER receives it (chapter 3.4).
 *
 * The producing side builds this object and knows it is well formed; the
 * consuming side reads bytes off a broker and knows nothing. Chapter 2.5 made
 * the same argument about the internal HTTP hop — an internal caller has no
 * more right to assume a payload's shape than an external one does — and a
 * message that has been sitting in a stream for six days has had even longer to
 * stop matching what the code expects. */
const envelope = {
  id: z.string().uuid(),
  environment_id: z.string().min(1),
  occurred_at: z.iso.datetime(),
};

/** A DISCRIMINATED UNION, AND IT WAS A LITERAL UNTIL CHAPTER 3.20 RAN IT.
 *
 * This schema was `type: z.literal("message.created")` inside a `strictObject`, and
 * the consumer that uses it — `services/api/src/consumer/runtime.ts:163` — answers a
 * failed parse with `message.term()`, which stops redelivery for good. So the first
 * `channel.member_added` row to reach the event spine would have been **destroyed at
 * the consumer**, logged as `consumer.unparseable`, with that chapter's own comment
 * saying "nothing catches what lands here".
 *
 * **The lane could not have found this.** It runs `RELAY_EVENT_CONSUMER=off`, so
 * nothing exercises the consumer; the api suite stayed green through 505 tests with
 * the defect in place. And analysis cleared it by reading the wrong file — there is a
 * second, permissive envelope in `packages/protocol/src/internal.ts:276` whose `type`
 * is `z.string().min(1)`, which is what a grep for "outboxEventSchema" finds first.
 *
 * Adding a type to `OUTBOX_EVENT_TYPES` now forces a branch here: the union is
 * exhaustive over the same three names, and a fourth added above without one below is
 * a typecheck failure rather than a terminated message in production. */
export const outboxEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope,
    type: z.literal("message.created"),
    data: z.strictObject({
      id: z.string().min(1),
      channel_id: z.string().min(1),
      seq: z.number().int().positive(),
      user: z.string().nullable(),
      text: z.string().nullable(),
      // Chapter 3.24 (FR-015). BOTH BRANCHES, and restated rather than shared for the
      // reason the comment above gives: FR-015 is the requirement that they not drift,
      // which is only meaningful if a change to one is visible in the other's absence.
      attachments: z.array(attachmentSchema),
      created_at: z.iso.datetime(),
    }),
  }),
  // CHAPTER 3.23. The union is exhaustive over `OUTBOX_EVENT_TYPES`, and this file's own
  // comment above says why that matters: `consumer/runtime.ts:163` answers a failed
  // parse with `message.term()`, which stops redelivery for good. A type added to the
  // array with no branch here is a row DESTROYED at the consumer, and the lane cannot
  // see it — it runs `RELAY_EVENT_CONSUMER=off`.
  z.strictObject({
    ...envelope,
    type: z.literal("message.updated"),
    // THE SAME SHAPE AS `message.created` (FR-008a). Restated rather than shared,
    // because a `strictObject` spread from one variable would let a change to the
    // creation's shape silently change the edit's — and FR-008a is the requirement
    // that they NOT drift, which is only meaningful if a change to one is visible.
    data: z.strictObject({
      id: z.string().min(1),
      channel_id: z.string().min(1),
      seq: z.number().int().positive(),
      user: z.string().nullable(),
      text: z.string().nullable(),
      // Chapter 3.24 (FR-015). BOTH BRANCHES, and restated rather than shared for the
      // reason the comment above gives: FR-015 is the requirement that they not drift,
      // which is only meaningful if a change to one is visible in the other's absence.
      attachments: z.array(attachmentSchema),
      created_at: z.iso.datetime(),
    }),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("message.deleted"),
    // NO `text` KEY AT ALL, and `strictObject` makes that enforceable in both
    // directions: a producer that adds one fails here, which is FR-020 with a test
    // rather than a promise.
    data: z.strictObject({
      id: z.string().min(1),
      channel_id: z.string().min(1),
      seq: z.number().int().positive(),
      user: z.string().nullable(),
      deleted_at: z.iso.datetime(),
    }),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("channel.member_added"),
    data: z.strictObject({
      channel_id: z.string().min(1),
      // NOT nullable, unlike the message's `user`. A message can have no sender
      // (chapter 3.17's senderless rows predate FR-MSG-15); a membership change
      // always has a member.
      user: z.string().min(1),
    }),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("channel.member_removed"),
    data: z.strictObject({
      channel_id: z.string().min(1),
      user: z.string().min(1),
    }),
  }),
]);
