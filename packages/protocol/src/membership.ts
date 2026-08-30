import { z } from "zod";

/** Membership's own fabric: two subject shapes and the payload that crosses them
 * (chapter 3.20, FR-RTM-05, FR-RTM-10).
 *
 * WHY THIS IS NOT IN `fanout.ts` AND NOT IN `presence.ts`. Each fabric owns its
 * subject grammar in its own file — `internal.ts` established that for the event
 * spine and chapter 3.19 followed it for presence. A new file is a whole-file fence
 * and leaves two chapters' hunks over `fanout.ts` alone.
 *
 * NOT `subjectFor`, WHICH `internal.ts` ALREADY EXPORTS. Chapter 3.18 paid for that
 * collision once:
 *
 *     error TS2308: Module "./internal.js" has already exported a member
 *     named 'subjectFor'.
 *
 * WHY TWO SHAPES AND NOT ONE. A membership change is addressed to a **user**, and
 * every fabric before this one was addressed to a channel. A removal can ride
 * `member:{channel_id}` and reach both audiences at once, because the removed user is
 * still a member at the moment it goes out. **An addition cannot**: the instance
 * holding the new member is not subscribed to that channel yet, so nothing derived
 * from the channel can reach it. That asymmetry is topology rather than taste, and it
 * is why this is the first event in the system whose recipient is a principal.
 *
 * The rejected alternative was publishing to every remaining member's user subject,
 * which replaces one publish with one per member — a thousand of them at FR-CHN-07's
 * ceiling, for one removal. */
export function subjectForChannelMembership(channelId: string): string {
  return `member:${channelId}`;
}

/** The principal-addressed half. `presence:{env}:{user}` is a Redis KEY and this is a
 * pub/sub CHANNEL — different namespaces, no collision — but the two read alike in a
 * log line, which is worth knowing before grepping for one and finding the other. */
export function subjectForUserMembership(
  environmentId: string,
  user: string,
): string {
  return `member:${environmentId}:${user}`;
}

/** What crosses `member:{…}` between gateway instances. Consumed only by gateways and
 * **never sent to a client**.
 *
 * `environment` IS ON THE FABRIC AND NOT ON THE WIRE. A receiving gateway checks it
 * against the connection it is about to act on and refuses a mismatch (FR-007); a
 * client already knows its own environment, and putting it on a socket frame would be
 * the first time this platform sent a tenant identifier to a client for no purpose.
 *
 * `strictObject`, so an unknown field is a rejection rather than a silent ignore: a
 * field added on one side of a rolling deploy fails loudly on the other instead of
 * being dropped. Chapter 3.19 chose the same strictness for the same reason.
 *
 * THE WIRE FRAME IS `frames.ts`'s AND IS NOT EDITED. What reaches a client is what
 * chapter 1.3 published and `frames.test.ts` asserts:
 *
 *     { type: "membership.changed", payload: { channel, user, change } }
 *
 * A BAN CARRIES `channel: "*"`. The alternative was a second payload shape, and one
 * schema with one parse won: the receiving instance drops every channel for that user
 * rather than one, and the sentinel is documented here rather than inferred from a
 * log line. `channel` stays `z.string().min(1)`, so `"*"` is a value the schema admits
 * and this comment is what makes it mean something. */
export const membershipFabricSchema = z.strictObject({
  environment: z.string().min(1),
  channel: z.string().min(1),
  user: z.string().min(1),
  change: z.enum(["added", "removed"]),
});

export type MembershipFabric = z.infer<typeof membershipFabricSchema>;

/** The `channel` value a ban publishes. A ban is a removal from every channel, so
 * `change` is `"removed"` and the channel is all of them. */
export const ALL_CHANNELS = "*";
