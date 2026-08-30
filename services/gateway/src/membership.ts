import {
  ALL_CHANNELS,
  membershipFabricSchema,
  subjectForChannelMembership,
  subjectForUserMembership,
  type MembershipFabric,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
import { Redis } from "ioredis";

// Membership's gateway half (chapter 3.20, FR-RTM-10).
//
// A THIRD FABRIC, AND THE FIRST ADDRESSED TO A PRINCIPAL. `chan:{channel_id}` carries
// messages and `presence:{channel_id}` carries transitions, and both assume the
// receiving instance is already subscribed to the channel. For a removal that holds;
// for an ADDITION it cannot, because the instance holding the new member is not
// subscribed to the channel they are about to join. So this module subscribes two
// ways — per channel, and per locally-connected user.
//
// ONE CLIENT, AND THE TASK LIST SAID TWO. Chapter 3.8's rule is that a connection in
// subscriber mode cannot run ordinary commands, so `fanout.ts` and `presence.ts` each
// carry a pair — and this module was specified with a pair by analogy. **It runs no
// ordinary commands.** Subscribe and unsubscribe are subscriber-mode operations, the
// re-read is an HTTP call to the api, and delivery is in-process; the command client
// was created, wired to an error listener, disconnected on close, and never used for
// anything. That makes six Redis connections per gateway rather than seven.
//
// NOTHING HERE IS A SOURCE OF TRUTH (constitution IV). The database decides who is a
// member; this carries the news, and `rereadIntervalMs` below is what makes a lost
// message recoverable rather than permanent.

export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** How often a connection re-reads its own membership from the api.
 *
 * **THE BACKSTOP IS NOT THE MECHANISM.** The publish meets FR-RTM-10's five seconds;
 * this bounds the damage when a publish is dropped, which constitution IV requires of
 * any new delivery mechanism — "durability and resume live in PostgreSQL sequences
 * and cursors", and a revocation has no cursor.
 *
 * Sixty seconds against NFR-SCL-01's 10,000 connections per instance is 167 requests
 * per second per instance; five seconds would be 2,000. The arithmetic is in
 * `baseline.txt` and the number is a decision with a cost rather than a default. */
export const DEFAULT_REREAD_INTERVAL_MS = 60_000;

export interface Membership {
  /** Register the delivery callback. Set by the session layer at wiring time, as the
   * fan-out's and presence's are: the fabric knows how to receive, the sessions know
   * who to hand it to. */
  onChange(handler: (change: MembershipFabric) => void): void;
  subscribeChannel(channelId: string): Promise<void>;
  unsubscribeChannel(channelId: string): Promise<void>;
  subscribeUser(environmentId: string, user: string): Promise<void>;
  unsubscribeUser(environmentId: string, user: string): Promise<void>;
  /** Every connection's periodic re-read, registered by the session layer. Returns a
   * cancel function, because a connection that closes must not keep asking. */
  watch(reread: () => Promise<void>): () => void;
  close(): Promise<void>;
}

export interface MembershipOptions {
  url?: string;
  logger: Logger;
  /** Defaults to production's. A test injects a short one — sixty seconds does not
   * fit in a package whose whole wall clock is forty-five, which is why the option
   * exists at all rather than as a matter of taste. */
  rereadIntervalMs?: number;
}

export function createMembership({
  url = process.env["RELAY_REDIS_URL"] ?? DEFAULT_REDIS_URL,
  logger,
  rereadIntervalMs = DEFAULT_REREAD_INTERVAL_MS,
}: MembershipOptions): Membership {
  // THE SUBSCRIBER KEEPS IOREDIS'S DEFAULT RETRY, unlike presence's command client.
  // It MUST reconnect when the store comes back, which is what "the next change
  // arrives without a restart" rests on. There is no fail-fast client here to
  // contrast it with, because there are no commands to fail.
  const subscriber = new Redis(url);

  // THE STATED REASON IS NFR-OBS-01, NOT PROCESS DEATH. `limits.ts` says a missing
  // listener kills the gateway; chapter 3.18 measured that against ioredis 6.0.0 and
  // the process stays alive, printing `[ioredis] Unhandled error event: …` itself.
  // The accurate reason is that those lines are unstructured and unbounded.
  subscriber.on("error", (error: unknown) => {
    logger.log("error", "membership.failed", {
      op: "connection",
      error: String(error),
    });
  });

  let deliver: (change: MembershipFabric) => void = () => {};

  // Reference-counted, because two members of one channel on one instance must not
  // unsubscribe each other. `fanout.ts` and `presence.ts` keep the same map over the
  // same ids, and this is the third.
  const channelCounts = new Map<string, number>();
  // And one per USER, which neither of those needed: a user with two connections on
  // one instance holds one subscription to their own subject.
  const userCounts = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();

  async function failable<T>(op: string, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      // Swallowed and logged, never rethrown: a membership-path failure must not fail
      // a connection, a disconnection, a send, or a message delivery (FR-015). And
      // the log line is the requirement's evidence — a path that silently does
      // nothing satisfies "the socket still opened" exactly as well as a working one.
      logger.log("error", "membership.failed", { op, error: String(error) });
      return null;
    }
  }

  async function count(
    counts: Map<string, number>,
    key: string,
    subject: string,
    direction: 1 | -1,
    op: string,
  ): Promise<void> {
    if (direction === 1) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next === 1) {
        await failable(op, () => subscriber.subscribe(subject));
      }
      return;
    }
    // `?? 0` and NOT `?? 1`. Chapter 3.19's presence module used the latter and the
    // coverage ratchet found the arm unreachable through `session.ts`; here an
    // unsubscribe for something never subscribed leaves the count at -1 with `?? 0`,
    // which is wrong, so the absent case returns early and is one of the arms the
    // phase's own list names.
    const current = counts.get(key);
    if (current === undefined) return;
    const next = current - 1;
    if (next <= 0) {
      counts.delete(key);
      await failable(op, () => subscriber.unsubscribe(subject));
    } else {
      counts.set(key, next);
    }
  }

  subscriber.on("message", (subject: string, raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.log("error", "membership.invalid_payload", { subject });
      return;
    }
    // Validated on receipt even though the fabric is inside the trust boundary.
    // `fanout.ts:77-79` states the reason and it is unchanged here: "inside" is one
    // compromised dependency away from "outside", and a malformed payload must not
    // reach a client.
    const change = membershipFabricSchema.safeParse(parsed);
    if (!change.success) {
      logger.log("error", "membership.invalid_payload", { subject });
      return;
    }
    deliver(change.data);
  });

  return {
    onChange(handler) {
      deliver = handler;
    },

    async subscribeChannel(channelId) {
      await count(
        channelCounts,
        channelId,
        subjectForChannelMembership(channelId),
        1,
        "subscribe:channel",
      );
    },

    async unsubscribeChannel(channelId) {
      await count(
        channelCounts,
        channelId,
        subjectForChannelMembership(channelId),
        -1,
        "unsubscribe:channel",
      );
    },

    async subscribeUser(environmentId, user) {
      await count(
        userCounts,
        `${environmentId}:${user}`,
        subjectForUserMembership(environmentId, user),
        1,
        "subscribe:user",
      );
    },

    async unsubscribeUser(environmentId, user) {
      await count(
        userCounts,
        `${environmentId}:${user}`,
        subjectForUserMembership(environmentId, user),
        -1,
        "unsubscribe:user",
      );
    },

    watch(reread) {
      const timer = setInterval(() => {
        void failable("reread", reread);
      }, rereadIntervalMs);
      // `unref` so a pending re-read never holds the process open — the same reason
      // presence's refresh loop does it.
      timer.unref();
      timers.add(timer);
      return () => {
        clearInterval(timer);
        timers.delete(timer);
      };
    },

    async close() {
      // Cleared, or a suite standing up two instances leaks a timer into the next
      // file. Chapter 3.19 recorded that exact failure.
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      channelCounts.clear();
      userCounts.clear();
      subscriber.disconnect();
    },
  };
}

/** Exported for the session layer's ban branch and for the tests, so the sentinel is
 * one string in one place rather than a `"*"` in three files. */
export { ALL_CHANNELS };
