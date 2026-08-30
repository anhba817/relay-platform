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
  created_at: string;
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
  data: MessageCreatedData | MembershipChangedData;
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
      created_at: z.iso.datetime(),
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
