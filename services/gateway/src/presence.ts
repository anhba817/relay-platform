import { randomUUID } from "node:crypto";

import {
  presenceFabricSchema,
  subjectForPresence,
  type PresenceFabric,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";
import { Redis } from "ioredis";

// Presence (chapter 3.19, ADR-19): who is online, and who is allowed to know.
//
// A SECOND FABRIC BESIDE THE FAN-OUT, NOT A SECOND PAYLOAD ON IT. `fanout.ts` is
// typed to messages at three points — `publish(message: Message)`, a
// `messageCreatedSchema` parse of everything arriving, and a literal
// `message.created` send — and the third is inside a delivery function ten
// chapters fence. So presence gets `presence:{channel_id}` and its own module,
// and `fanout.ts` is not edited at all. The declared cost is two subscriptions
// per channel instead of one.
//
// TWO CLIENTS, for the reason chapter 3.8 gave for the limiter's: a connection in
// subscriber mode cannot run ordinary commands, and presence needs `SET`,
// `EXISTS` and `PUBLISH` as well as `SUBSCRIBE`. That makes five Redis
// connections per gateway — fanout's two, the limiter's one, and these — and each
// close has an owner.
//
// NOTHING HERE IS A SOURCE OF TRUTH (constitution IV, ADR-10). Presence loss is
// cosmetic and self-heals on the next transition; the correct amount of
// durability for a green circle is none.

export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** FR-RTM-06 says thirty seconds. Asserted by a test rather than left as a bare
 * constant, so the clause is represented somewhere a reader can find it. */
export const DEFAULT_GRACE_MS = 30_000;
/** `docs/05-sad.md`'s presence key. Must be >= `graceMs`; the close re-pins the
 * key anyway, so this is the sane default rather than the mechanism. */
export const DEFAULT_TTL_MS = 30_000;
/** Three refreshes per TTL, so two consecutive misses do not expire a live user.
 * NOT `PING_INTERVAL_MS`, which is also 30_000: a TTL equal to its refresh
 * interval expires a connected user. Three thirty-second numbers in this system
 * are three different quantities (research R3). */
export const DEFAULT_REFRESH_MS = 10_000;
/** How long after the grace ends the check runs. Not padding — without it the
 * key's expiry and the check are the same instant reached by two clocks, and a
 * tie strands the user online permanently (research R2b). */
export const DEFAULT_MARGIN_MS = 1_000;

/** Did this caller cause the transition?
 *
 * `SET … NX` answers `"OK"` for the one caller that found the key absent and null
 * for everyone else. Factored out because the module builds its own Redis clients
 * from a url and cannot be handed a double — the gateway's shape is pure logic in
 * `.test.ts` and Redis in `.itest.ts`, which is why `limits.ts` exports
 * `overLimit` and `windowStartFor` the same way. */
export function wonTransition(reply: string | null): boolean {
  return reply === "OK";
}

export interface Presence {
  /** Register the delivery callback. Set by the session layer at wiring time, as
   * the fan-out's is: the fabric knows how to receive, the sessions know who to
   * hand it to. */
  onTransition(
    handler: (channelId: string, payload: PresenceFabric) => void,
  ): void;
  /** A connection opened. May publish `online`; publishes nothing when the user
   * was already online anywhere. */
  connected(
    environmentId: string,
    user: string,
    channelIds: Iterable<string>,
  ): Promise<void>;
  /** A connection closed and the caller has already removed it from the registry.
   * When it was the user's last connection on this instance: re-pins the key to
   * `graceMs`, awaits that, then schedules one check at `graceMs + marginMs`,
   * replacing any pending one for that user. */
  disconnected(
    environmentId: string,
    user: string,
    channelIds: Iterable<string>,
  ): Promise<void>;
  /** Claim a transition for one connection. True the first time, false after —
   * a watcher sharing three channels receives three copies of one transition and
   * must be handed exactly one frame (FR-012). */
  claim(transition: string, connectionId: string): boolean;
  subscribe(channelId: string): Promise<void>;
  unsubscribe(channelId: string): Promise<void>;
  close(): Promise<void>;
}

export interface PresenceOptions {
  url?: string;
  logger: Logger;
  graceMs?: number;
  ttlMs?: number;
  refreshMs?: number;
  marginMs?: number;
}

export function createPresence({
  url = process.env.RELAY_REDIS_URL ?? DEFAULT_REDIS_URL,
  logger,
  graceMs = DEFAULT_GRACE_MS,
  ttlMs = DEFAULT_TTL_MS,
  refreshMs = DEFAULT_REFRESH_MS,
  marginMs = DEFAULT_MARGIN_MS,
}: PresenceOptions): Presence {
  const commands = new Redis(url);
  const subscriber = new Redis(url);

  // THE STATED REASON FOR THESE LISTENERS IS NOT THE ONE THE LIMITER GIVES.
  // `limits.ts` says a missing listener means "the gateway would die"; chapter
  // 3.18 measured that against ioredis 6.0.0 by reproducing the exact client, and
  // the process STAYS ALIVE — ioredis prints `[ioredis] Unhandled error event: …`
  // itself and continues. Seven lines in four seconds against a dead port.
  //
  // The accurate reason is that those lines are unstructured and unbounded, which
  // defeats NFR-OBS-01. A presence path that cannot reach Redis is an expected
  // state; it should say so once, in the log vocabulary this module owns.
  for (const [name, client] of [
    ["commands", commands],
    ["subscriber", subscriber],
  ] as const) {
    client.on("error", (error: unknown) => {
      logger.log("error", "presence.failed", {
        op: `connection:${name}`,
        error: String(error),
      });
    });
  }

  void graceMs;
  void refreshMs;
  void marginMs;

  let deliver: (channelId: string, payload: PresenceFabric) => void = () => {};

  // Reference-counted, because two members of one channel on one instance must not
  // unsubscribe each other. One count per channel and two Redis calls under it —
  // `fanout.ts` keeps the same map for the same reason, over the same ids.
  const counts = new Map<string, number>();

  /** A transition publishes on every one of the subject's channels, so an instance
   * hosting a watcher who shares three of them receives three copies of one
   * transition. This is what makes the watcher see one frame: the id is minted per
   * transition, and a receiver delivers each `(transition, connection)` pair once.
   *
   * Cleared on a timer rather than kept: every copy of one transition arrives
   * within milliseconds of the others, so a few seconds is generous and unbounded
   * growth is the alternative. */
  const seen = new Map<string, Set<string>>();

  const key = (environmentId: string, user: string): string =>
    `presence:${environmentId}:${user}`;

  async function failable<T>(op: string, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      // Swallowed and logged, never rethrown: presence is the only thing that may
      // degrade (FR-023). And the log line is the REQUIREMENT'S EVIDENCE — a path
      // that silently does nothing satisfies "the socket still opened" exactly as
      // well as a working one does, which is chapter 3.18's trap against its own
      // publisher.
      logger.log("error", "presence.failed", { op, error: String(error) });
      return null;
    }
  }

  async function publish(
    environmentId: string,
    user: string,
    state: "online" | "offline",
    channelIds: Iterable<string>,
  ): Promise<void> {
    const transition = randomUUID();
    const payload: PresenceFabric = { user, state, transition };
    const body = JSON.stringify(payload);
    const channels = [...channelIds];
    await failable("publish", async () => {
      await Promise.all(
        channels.map((channelId) =>
          commands.publish(subjectForPresence(channelId), body),
        ),
      );
    });
    // `channels` is a COUNT, not a list. The number is useful in an incident; the
    // list is a membership graph in a log file (constitution VI).
    logger.log("info", "presence.published", {
      user,
      state,
      channels: channels.length,
    });
  }

  subscriber.on("message", (subject: string, raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.log("error", "presence.invalid_payload", { subject });
      return;
    }
    // Validated on receipt even though the fabric is inside the trust boundary.
    // `fanout.ts:77-79` states the reason and it is unchanged here: "inside" is one
    // compromised dependency away from "outside", and a malformed payload must not
    // reach a client.
    const payload = presenceFabricSchema.safeParse(parsed);
    if (!payload.success) {
      logger.log("error", "presence.invalid_payload", { subject });
      return;
    }
    deliver(subject.slice("presence:".length), payload.data);
  });

  return {
    onTransition(handler) {
      deliver = handler;
    },

    async connected(environmentId, user, channelIds) {
      // `SET … NX` IS THE ELECTION. Exactly one caller across every instance gets
      // `OK` for a user who was absent; everyone else gets null and stays quiet.
      // Measured against Redis 8.10.0 rather than reasoned about (research R2).
      const reply = await failable("connected:set", () =>
        commands.set(key(environmentId, user), "1", "PX", ttlMs, "NX"),
      );
      if (!wonTransition(reply)) {
        logger.log("info", "presence.suppressed", {
          user,
          state: "online",
          reason: "already online",
        });
        return;
      }
      // The offline marker is cleared by whoever wins the online transition, so the
      // next departure can elect a publisher again.
      await failable("connected:clear-marker", () =>
        commands.del(`presence:offline:${environmentId}:${user}`),
      );
      await publish(environmentId, user, "online", channelIds);
    },

    async disconnected() {
      // Phase 4, T049: re-pin the key, await it, then arm the grace check.
    },

    async subscribe(channelId) {
      const next = (counts.get(channelId) ?? 0) + 1;
      counts.set(channelId, next);
      if (next === 1) {
        await failable("subscribe", () =>
          subscriber.subscribe(subjectForPresence(channelId)),
        );
      }
    },

    async unsubscribe(channelId) {
      const next = (counts.get(channelId) ?? 1) - 1;
      if (next <= 0) {
        counts.delete(channelId);
        await failable("unsubscribe", () =>
          subscriber.unsubscribe(subjectForPresence(channelId)),
        );
      } else {
        counts.set(channelId, next);
      }
    },

    /** True when this connection has not already been handed this transition.
     * Records as a side effect, which is why it is a method and not a predicate. */
    claim(transition, connectionId) {
      let holders = seen.get(transition);
      if (!holders) {
        holders = new Set();
        seen.set(transition, holders);
        setTimeout(() => seen.delete(transition), 5_000).unref();
      }
      if (holders.has(connectionId)) return false;
      holders.add(connectionId);
      return true;
    },

    async close() {
      subscriber.disconnect();
      commands.disconnect();
    },
  };
}
