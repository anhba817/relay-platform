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

  all(): Connection[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}
