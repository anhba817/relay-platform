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

/** When the grace check runs, relative to the close.
 *
 * NOT `graceMs`. The close re-pins the key to expire at `graceMs`, so pinning and
 * checking at the same instant puts two deadlines on one moment reached by two
 * clocks — the key expires at `close + δ + graceMs` where δ is a round trip, the
 * timer fires at `close + graceMs + ε`. With `ε < δ` the check finds the key alive,
 * logs `presence.suppressed`, and its ONE-SHOT timer is gone: the user is stranded
 * online, which is worse than the duplicate `online` the re-pin was added to
 * prevent. Redis also holds a key until `now` is strictly past its expiry, so a tie
 * falls the wrong way too (research R2b). */
export function graceCheckDelay(graceMs: number, marginMs: number): number {
  return graceMs + marginMs;
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
  // FAIL FAST RATHER THAN QUEUE, which is the limiter's shape and not the fan-out's.
  // Default ioredis retries forever and QUEUES commands, so against a dead store a
  // `SET` neither succeeds nor rejects — it waits, and the failure path this module
  // documents is never taken. Chapter 3.18 measured the same thing about its
  // publisher: "default ioredis retries FOREVER, so `publish` never rejects and the
  // command queues."
  //
  // The subscriber keeps its retry behaviour: it MUST reconnect when the store comes
  // back, which is what "the next transition publishes without a restart" rests on.
  const commands = new Redis(url, {
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  });
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
  const marker = (environmentId: string, user: string): string =>
    `presence:offline:${environmentId}:${user}`;

  /** Users this instance currently holds a connection for, and the environment each
   * belongs to. The refresh loop walks this; `disconnected` removes from it. */
  const held = new Map<string, string>();

  /** One pending grace check per user, REPLACED rather than added to. Close, reopen
   * at a third of the window, close again must leave one decision answered by the
   * state at the end of the second window — two timers would publish twice. */
  const pending = new Map<string, NodeJS.Timeout>();

  const refreshTimer = setInterval(() => {
    void (async () => {
      for (const [user, environmentId] of held) {
        const reply = await failable("refresh", () =>
          commands.set(key(environmentId, user), "1", "PX", ttlMs, "XX"),
        );
        // `XX` answers null when the key is gone — a Redis restart or an eviction
        // under a live connection. Treat it as a new transition: a duplicate
        // `online` for a user who never left, which ADR-10 permits and FR-031
        // authorises, and which beats a user who is online and unpublishable.
        if (reply === null) {
          logger.log("info", "presence.suppressed", {
            user,
            state: "online",
            reason: "key vanished under a live connection; re-electing",
          });
          await failable("refresh:reelect", async () => {
            const won = await commands.set(
              key(environmentId, user),
              "1",
              "PX",
              ttlMs,
              "NX",
            );
            if (wonTransition(won)) await commands.del(marker(environmentId, user));
          });
        }
      }
    })();
  }, refreshMs);
  refreshTimer.unref();

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
      held.set(user, environmentId);
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

    async disconnected(environmentId, user, channelIds) {
      // The caller has already removed the connection AND established that no other
      // local one remains — `session.ts` asks `registry.connectionsFor` for that.
      // So dropping the refresh here is correct: this instance holds nothing for
      // this user any more.
      held.delete(user);
      // The channel set is captured HERE, at the close, and held by the closure the
      // check runs in. By the time it fires the connection is out of the registry.
      // It is only ever used when nobody returned, in which case it is still right.
      const channels = [...channelIds];

      // RE-PIN, AND AWAIT IT BEFORE ARMING THE TIMER. Without the re-pin the key
      // dies at `last_refresh + ttlMs`, which is up to `refreshMs` BEFORE the grace
      // ends — and a reconnection in that gap wins `SET … NX` and publishes a second
      // `online` for a user who never left (FR-007, research R2a). `XX` so it never
      // resurrects a key that is already gone.
      //
      // The await is the other half: it puts the round trip inside the wait instead
      // of racing the timer (research R2b).
      await failable("disconnected:repin", () =>
        commands.set(key(environmentId, user), "1", "PX", graceMs, "XX"),
      );

      const existing = pending.get(user);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        pending.delete(user);
        void (async () => {
          // The key is absent only if no instance refreshed it for a whole window —
          // which is the same question as "does anybody still hold a connection?",
          // asked without a membership set. `docs/05-sad.md`'s `conn:{env}:{user}`
          // is not needed for this (research R6).
          const alive = await failable("grace:exists", () =>
            commands.exists(key(environmentId, user)),
          );
          if (alive !== 0) {
            logger.log("info", "presence.suppressed", {
              user,
              state: "offline",
              reason: "a connection is still open somewhere",
            });
            return;
          }
          // Two instances whose last connections close in the same tick both find
          // the key absent. `SET … NX` on a separate marker gives exactly one of
          // them the right to speak.
          const won = await failable("grace:elect", () =>
            commands.set(marker(environmentId, user), "1", "PX", ttlMs, "NX"),
          );
          if (!wonTransition(won)) {
            logger.log("info", "presence.suppressed", {
              user,
              state: "offline",
              reason: "another instance published it",
            });
            return;
          }
          await publish(environmentId, user, "offline", channels);
        })();
      }, graceCheckDelay(graceMs, marginMs));
      timer.unref();
      pending.set(user, timer);
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
      // Cleared, or a suite standing up two instances leaks a timer into the next
      // file. A draining instance also abandons its pending offlines — stated in
      // the chapter rather than discovered: nothing publishes them, the key expires
      // silently, and watchers hold a stale green circle until the subject next
      // transitions. ADR-10 permits that; a reader should still be told.
      clearInterval(refreshTimer);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      held.clear();
      seen.clear();
      subscriber.disconnect();
      commands.disconnect();
    },
  };
}
