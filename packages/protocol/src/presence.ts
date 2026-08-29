import { z } from "zod";

/** Presence's own fabric: a subject grammar and the payload that crosses it
 * (chapter 3.19, ADR-19).
 *
 * WHY THIS IS NOT IN `fanout.ts`. The fan-out's subject grammar lives there and
 * presence's could have joined it, three lines below `subjectForChannel`. It does
 * not, for the reason `internal.ts` already demonstrates: the event spine keeps
 * its own `subjectFor` in its own file, so **each fabric owning its subject
 * grammar is this package's established shape** rather than a compromise. The
 * practical payoff is that `fanout.ts` gains no hunk, and chapter 3.18's fences
 * over it stay where they are.
 *
 * NOT `subjectFor` and not `subjectForChannel`. `internal.ts` exports the first
 * and `fanout.ts` the second, and chapter 3.18 paid for that collision once:
 *
 *     error TS2308: Module "./internal.js" has already exported a member
 *     named 'subjectFor'.
 *
 * WHY A SECOND SUBJECT AT ALL, rather than enveloping two kinds on `chan:{id}`.
 * The message path is typed to messages at three points, and only two of them are
 * in one file: `publish(message: Message)` and a `messageCreatedSchema` parse in
 * `services/gateway/src/fanout.ts`, then the literal `message.created` send inside
 * `session.ts`'s `deliver` — a function ten chapters fence. Enveloping means
 * editing the hot path to serve the lowest-volume traffic on it. Separating the subjects also makes cross-kind
 * mis-delivery impossible rather than test-enforced: a presence payload cannot
 * arrive where a message parse is waiting, because nothing publishes it there.
 *
 * The declared cost: a channel now carries two subscriptions rather than one. */
export function subjectForPresence(channelId: string): string {
  return `presence:${channelId}`;
}

/** What crosses `presence:{channel_id}` between gateway instances. Consumed only
 * by gateways and **never sent to a client**.
 *
 * `transition` IS WHY A WATCHER SHARING THREE CHANNELS GETS ONE FRAME. A
 * transition publishes on every one of the subject's channels, so an instance
 * hosting a watcher who shares three of them receives three copies. The wire
 * frame carries `user` and `state` and no channel, so the copies are
 * indistinguishable duplicates; the id lets a receiver deliver a given transition
 * to a given connection once. It is minted per transition, not per publish.
 *
 * THIS IS THE FIRST TIME THE FABRIC PAYLOAD AND THE WIRE FRAME DIFFER. On the
 * message path they are the same object — which is exactly why `fanout.ts` could
 * type its `publish` as `Message` and get away with it. What reaches a client is
 * still what chapter 1.3 published and `frames.test.ts` asserts:
 *
 *     { type: "presence.changed", payload: { user, state } }
 *
 * `strictObject`, so an unknown field is a rejection rather than a silent
 * ignore: a field added on one side of a rolling deploy fails loudly on the
 * other. */
export const presenceFabricSchema = z.strictObject({
  user: z.string().min(1),
  state: z.enum(["online", "offline"]),
  transition: z.string().min(1),
});

export type PresenceFabric = z.infer<typeof presenceFabricSchema>;
