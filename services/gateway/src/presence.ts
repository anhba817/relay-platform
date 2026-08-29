import type { PresenceFabric } from "@relay/protocol";
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

export interface Presence {
  /** Register the delivery callback. Set by the session layer at wiring time, as
   * the fan-out's is: the fabric knows how to receive, the sessions know who to
   * hand it to. */
  onTransition(
    handler: (channelId: string, payload: PresenceFabric) => void,
  ): void;
  /** A connection opened. May publish `online`; publishes nothing when the user
   * was already online anywhere. */
  connected(user: string, channelIds: Iterable<string>): Promise<void>;
  /** A connection closed and the caller has already removed it from the registry.
   * When it was the user's last connection on this instance: re-pins the key to
   * `graceMs`, awaits that, then schedules one check at `graceMs + marginMs`,
   * replacing any pending one for that user. */
  disconnected(user: string, channelIds: Iterable<string>): Promise<void>;
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
  void ttlMs;
  void refreshMs;
  void marginMs;

  return {
    onTransition() {
      // Phase 3, T031: the delivery path in `session.ts` registers here.
    },
    async connected() {
      // Phase 3, T027: `SET … NX`, mint a transition, publish on each subject.
    },
    async disconnected() {
      // Phase 4, T049: re-pin the key, await it, then arm the grace check.
    },
    async subscribe() {
      // Phase 3, T028: reference-counted `SUBSCRIBE presence:{channel_id}`.
    },
    async unsubscribe() {
      // Phase 3, T028.
    },
    async close() {
      subscriber.disconnect();
      commands.disconnect();
    },
  };
}
