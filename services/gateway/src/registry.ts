import type { WebSocket } from "ws";

import type { Message } from "@relay/protocol";

import type { Identity } from "./auth.js";
import type { ResumePhase } from "./resume.js";

// The in-memory connection registry (chapter 2.5): who is connected to
// THIS instance, and which channels they can hear. Its cross-instance
// story is deliberately absent — chapter 2.6 exists because of what this
// file cannot see.
//
// Note what else is absent: no pg, no drizzle-orm, no repository import.
// The gateway never touches the database (ADR-05) — and the lint ban from
// 2.1 makes the mistake a build failure, not a review comment.

export interface Connection {
  readonly id: string;
  readonly identity: Identity;
  readonly socket: WebSocket;
  channelIds: Set<string>;
  missedPings: number;
  /** Chapter 2.7. A connection resuming through the tunnel spends its first
   * milliseconds holding live frames back so the backfill can go first; a
   * fresh connect is born "live" and never buffers. Delivery reads this
   * field and nothing else — the resume machinery is invisible to it. */
  phase: ResumePhase;
  buffer: Message[];
  /** Set when the buffer hit its ceiling. The frames are gone, so the
   * client must be told to page history instead of trusting the stream. */
  overflowed: boolean;
  /** Chapter 3.7. Per channel, the highest sequence this connection's backfill
   * delivered — kept for the connection's life so that a frame the fabric
   * announces AFTER the resume has finished can still be recognised as one the
   * client already holds.
   *
   * Three states, and the middle one is not the same as the first:
   *
   *   null            a fresh connect, or a resume that degraded — suppress nothing
   *   {}              a resume whose cursor set was empty after scoping
   *   { chan: 42 }    suppress at or below 42 on that channel
   *
   * NEVER RETIRED while the connection lives. Retiring on a higher sequence looks
   * like the natural way to bound this and hands the duplicate straight back:
   * sequences commit in order under a channel row lock but are published by
   * whichever gateway instance handled each send, so a prompt 43 can beat a stalled
   * 42. Bounded instead by `MAX_RESUME_CHANNELS`, which already caps the cursors
   * these are scoped to. */
  marks: Record<string, number> | null;
  /** Chapter 3.8. The environment's send allowance, as it stood when this socket
   * connected — carried on the session response because the gateway has no
   * database and must not gain one (research R12).
   *
   * FIXED FOR THE LIFE OF THE CONNECTION, and that is a stated property rather
   * than an accident: a limit changed while a socket is open does not reach it
   * until the client reconnects. The alternative is a Postgres read per frame, on
   * the hot path of the thing the limit protects. Beside `marks` for the same
   * reason — it describes one socket and dies with it. */
  sendLimit: number;
  /** Chapter 3.11. When this socket opened, and which environment owes for it.
   *
   * The meter needs both and the registry is where they belong, beside `marks`
   * and `sendLimit` and for the same reason: this describes one socket and dies
   * with it. Nothing here survives the instance, and nothing needs to — a
   * connection lives on exactly one gateway and its id is minted here.
   *
   * `openedAt` RATHER THAN A RUNNING TOTAL. The unit is a wall-clock minute
   * bucket, so what a connection owes is a function of when it opened and what
   * time it is now; keeping a counter instead would need a tick to increment it
   * and would drift the moment one was missed. */
  openedAt: Date;
  environmentId: string;
}

export class Registry {
  private readonly byId = new Map<string, Connection>();

  add(connection: Connection): void {
    this.byId.set(connection.id, connection);
  }

  remove(connectionId: string): void {
    this.byId.delete(connectionId);
  }

  /** Every local connection that should hear about this channel. 2.6 turns
   * the same question into a cross-instance one; the answer's shape does
   * not change, only where the question travels. */
  subscribersOf(channelId: string): Connection[] {
    return [...this.byId.values()].filter((c) => c.channelIds.has(channelId));
  }

  /** Chapter 3.19. Every local connection this user holds — the question presence
   * asks at a close: "was that the last one on this instance?"
   *
   * A FILTER RATHER THAN A SECOND INDEX. `subscribersOf` above is the same shape
   * for the same reason: one instance's connection set is small, and a second map
   * is a second thing to keep correct at `add` and `remove`. The cross-instance
   * half of this question is not asked here at all — Redis answers it, because
   * this file's whole point since 2.5 is that it cannot see other instances. */
  connectionsFor(userExternalId: string): Connection[] {
    return [...this.byId.values()].filter(
      (c) => c.identity.userExternalId === userExternalId,
    );
  }

  all(): Connection[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}
