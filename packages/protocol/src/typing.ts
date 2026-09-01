import { z } from "zod";

/** Typing's own fabric: one subject shape and the payload that crosses it
 * (chapter 3.21, FR-RTM-05, FR-RTM-08).
 *
 * WHY THIS IS NOT IN `fanout.ts`, `presence.ts` OR `membership.ts`. Each fabric
 * owns its subject grammar in its own file — `internal.ts` established that for
 * the event spine, chapter 3.19 followed it for presence and 3.20 for
 * membership. A new file is a whole-file fence and leaves three chapters' hunks
 * over `fanout.ts` alone.
 *
 * **Three chapters have now reached the same rule from three starting points, so
 * it is the pattern rather than a judgement call: a fabric owns its subject
 * grammar, and a kind that cannot share a payload type cannot share a subject.**
 * The brief for this chapter assumed the opposite — that typing was the one
 * remaining kind that could reuse `chan:{channel_id}` — and research R1 ran the
 * grep that settled it: the message path is typed to messages at SEVEN places,
 * where ADR-19's record counts three.
 *
 * NOT `subjectFor`, WHICH `internal.ts` ALREADY EXPORTS. Chapter 3.18 paid for
 * that collision once:
 *
 *     error TS2308: Module "./internal.js" has already exported a member
 *     named 'subjectFor'.
 *
 * WHY ONE SHAPE AND NOT TWO. Chapter 3.20 needed a second, principal-addressed
 * subject because an addition cannot ride the channel it adds you to — the
 * instance holding the new member is not subscribed yet. Typing has no such
 * case: a signal is only ever interesting to people already in the channel, and
 * a member who cannot hear the subject has nothing to be told. */
export function subjectForTyping(channelId: string): string {
  return `typing:${channelId}`;
}

/** What crosses `typing:{channel_id}` between gateway instances. Consumed only by
 * gateways and **never sent to a client** — the wire frame is `frames.ts`'s.
 *
 * `environment` IS ON THE FABRIC AND NOT ON THE WIRE, as chapter 3.20's is and
 * for the same reason: a receiving gateway checks it against the connection it is
 * about to act on, while a client already knows its own environment and has no
 * use for a tenant id.
 *
 * `user` IS HERE AND IS NOT ON THE INBOUND FRAME. `typingSendSchema` carries a
 * channel and nothing else, because the connection supplies the identity — a
 * client that could name a user could type as anybody (FR-006). The publishing
 * gateway fills this field in from the authenticated connection, which is the
 * one place it can be trusted.
 *
 * `strictObject`, so an unknown field is a rejection rather than a silent ignore:
 * a field added on one side of a rolling deploy fails loudly on the other instead
 * of being dropped. Chapters 3.19 and 3.20 chose the same strictness for the same
 * reason.
 *
 * **NO `state` FIELD, AND THE ABSENCE IS THE CHAPTER.** There is no "started" or
 * "stopped" to carry: `typingSchema` has published `{ channel, user }` since
 * chapter 1.3, so nothing on the wire can end an indicator and the five-second
 * expiry belongs to the receiving client (FR-009). Adding one here would be the
 * first half of a design this protocol cannot finish. */
export const typingFabricSchema = z.strictObject({
  environment: z.string().min(1),
  channel: z.string().min(1),
  user: z.string().min(1),
});

export type TypingFabric = z.infer<typeof typingFabricSchema>;
