import { Redis } from "ioredis";

import type { Logger } from "@relay/service-kit";

const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** FR-RTM-09's five, and **FR-002 says it is stated exactly once**. The
 * requirement is about drift, not about the value: a second literal five is how
 * two figures come apart, which is what `services/api/src/limits/policy.ts` did
 * when it derived `connect: 3_000` from "ten thousand divided by five" and shipped
 * a third number. `connections.test.ts` asserts this constant is the only one. */
export const MAX_CONNECTIONS_PER_USER = 5;

/** How long after a connection's last successful renewal its place stops counting.
 * `docs/05-sad.md:574` already published 60 s for this key and the figure is kept.
 *
 * IT IS ALSO HOW LONG A CRASHED TAB HOLDS A SLOT, which the spec's Q1 names as the
 * accepted cost of refusing the newest rather than evicting the oldest. */
export const DEFAULT_BOUND_MS = 60_000;

/** Three renewals per bound, so two consecutive misses do not free a live
 * connection's place.
 *
 * **NOT `PING_INTERVAL_MS`, which is also a number in this file's neighbourhood.**
 * `session.ts:48` sets the protocol keepalive to 30_000, and chapter 3.19 paid for
 * conflating three 30-second numbers that turned out to be three quantities — a TTL
 * equal to its own refresh interval expires a connected user. Tying a Redis TTL to
 * a client-visible keepalive means changing the ping starts expiring slots. Separate
 * timer, separate number, and the tests assert the RATIO rather than the values. */
export const DEFAULT_HEARTBEAT_MS = 20_000;

/** Written into a slot key to retire it. Any value that cannot be a connection id
 * does, and `randomUUID` never produces this one.
 *
 * **IT MEANS FREE, NOT BUSY**, and reading it the other way was a defect. See
 * `walk` below: a claim takes a tombstoned slot rather than stepping over it. */
const TOMBSTONE = "-";

/** How long a tombstone lingers. One millisecond is enough to be a conditional
 * delete and short enough to be invisible — but the number is named and injectable
 * because **a test that has to fit inside one millisecond is a test that races**,
 * and the arithmetic below only worked by accident when it was a literal. */
export const DEFAULT_TOMBSTONE_MS = 1;

/** What a claim attempt resolved to. `held` is for FR-015's log line and is
 * discovered by the walk rather than read: five keys have no cheap `ZCARD`, and
 * `research.md` R3 records that as the design's stated cost. */
export type ClaimOutcome =
  | { readonly kind: "claimed"; readonly slot: number; readonly held: number }
  | { readonly kind: "full"; readonly held: number }
  | { readonly kind: "unenforced" };

/** What a renewal resolved to. **`reclaimed` carries a slot that may differ from
 * the one handed in** — FR-011b's common case is that the outage cost nothing and
 * some other slot was free, so the caller must store the new number. */
export type RenewOutcome =
  | { readonly kind: "renewed" }
  | { readonly kind: "reclaimed"; readonly slot: number }
  | { readonly kind: "full"; readonly held: number }
  | { readonly kind: "unenforced" };

export interface Connections {
  claim(
    environmentId: string,
    user: string,
    connectionId: string,
  ): Promise<ClaimOutcome>;
  renew(
    environmentId: string,
    user: string,
    connectionId: string,
    slot: number,
  ): Promise<RenewOutcome>;
  release(
    environmentId: string,
    user: string,
    connectionId: string,
    slot: number,
  ): Promise<void>;
  /** Every place this instance holds, freed at once. FR-011a: a deployment must
   * cost no more than one reconnection cycle (NFR-REL-03), and `wss.close()` does
   * not close established sockets — so without this a deploy holds five slots for
   * a full bound and the next connection is refused. */
  releaseAll(
    held: readonly {
      readonly environmentId: string;
      readonly user: string;
      readonly connectionId: string;
      readonly slot: number;
    }[],
  ): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectionsOptions {
  url?: string;
  logger: Logger;
  boundMs?: number;
  /** Widened by one test, to hold the window open long enough to assert what
   * happens inside it. */
  tombstoneMs?: number;
}

/** `conn:{env}:{user}:{slot}`, one key per place, and the shape is an argument
 * against a published row.
 *
 * `docs/05-sad.md:574` prescribes a sorted set pruned with `ZREMRANGEBYSCORE` on
 * read. That needs Lua for FR-013's atomic check-and-insert, Constitution VII
 * requires "a superseding ADR with profiling evidence" for a second language, and
 * this lane cannot produce it — its largest fixture holds five channels while
 * NFR-SCL-01 asks about ten thousand connections. **Making each member its own key
 * means the TTL is per member by construction rather than worked around**, which
 * was the defect that row recorded in the first place. ADR-23 carries the drivers
 * and the reversal condition. */
const key = (environmentId: string, user: string, slot: number): string =>
  `conn:${environmentId}:${user}:${slot}`;

export function createConnections({
  url = process.env["RELAY_REDIS_URL"] ?? DEFAULT_REDIS_URL,
  logger,
  boundMs = DEFAULT_BOUND_MS,
  tombstoneMs = DEFAULT_TOMBSTONE_MS,
}: ConnectionsOptions): Connections {
  // THE SAME THREE OPTIONS `limits.ts:95` AND `presence.ts:133` USE, and the cap
  // needs them more than either. With ioredis' defaults an unreachable Redis does
  // not fail — it queues the command and retries, so `claim` HANGS. Measured at
  // 20 s in `connections.test.ts` before these were added, against NFR-PRF-04's
  // p95 < 1 s from handshake to `connection.ack`. **A cap that fails open must
  // fail open QUICKLY**, or FR-016's "accept the connection" is indistinguishable
  // from refusing it.
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  });
  // One `error` listener, because a client without one turns a connection error
  // into an unhandled rejection that takes the process down. Chapter 3.18's R10
  // found `createFanout` without one while both rate limiters had one and
  // explained why.
  client.on("error", (error: Error) => {
    logger.log("error", "connections.redis", { detail: error.message });
  });

  /** `SET … IFEQ … PX` THROUGH `call`, AND THE REASON IS THE TYPED CLIENT RATHER
   * THAN THE SERVER. Redis 8.10.0 accepts the combination — verified by hand
   * against the lane before this module existed. ioredis 6.0.0 declares only
   * `set(key, value, 'IFEQ', cmp)` and `set(key, value, 'IFEQ', cmp, 'GET')`;
   * **there is no overload pairing `IFEQ` with `PX`**, so the typed API cannot
   * express it and `call` is the documented escape hatch.
   *
   * The premise check in Phase 1 said `IFEQ` was "present in
   * `RedisCommander.d.ts`, so no cast" — and the TOKEN's presence is not an
   * overload. Same class as everything else this chapter has corrected: a grep
   * for a shape rather than for the set.
   *
   * The alternatives are worse. `SET … IFEQ` then `PEXPIRE` is two commands, and
   * a failure between them leaves a slot with no TTL — leaked for ever, which is
   * the original defect rather than a variation on it. `KEEPTTL` preserves the
   * ORIGINAL expiry, so a renewal would never extend anything and every slot
   * would die 60 s after its claim. */
  const setIfEq = async (
    k: string,
    value: string,
    comparison: string,
    px: number,
  ): Promise<string | null> =>
    (await client.call(
      "SET",
      k,
      value,
      "IFEQ",
      comparison,
      "PX",
      String(px),
    )) as string | null;

  /** COULD NOT ASK is a distinct OUTCOME, not a distinct value — and the first
   * version of this function got that wrong in a way its own comment denied.
   *
   * It returned `T | null` and read `null` as failure. But `SET … NX` returns
   * **nil on a miss**, which is the ordinary case when a slot is taken, so every
   * claim past the first was reported as `unenforced`: six of fourteen unit tests
   * red, all with `expected { kind: 'unenforced' }`. **Arm 1 and arm 5 of the arms
   * list produce the same wire value**, and listing them separately did not stop
   * me writing code that could not tell them apart.
   *
   * A wrapper makes the two unmistakable. `presence.ts:232` gets away with `T |
   * null` because its `SET` uses `NX`/`XX` where nil and failure lead to the same
   * branch; this module has to distinguish them. */
  type Asked<T> = { readonly asked: true; readonly reply: T } | { readonly asked: false };

  async function failable<T>(op: string, work: () => Promise<T>): Promise<Asked<T>> {
    try {
      return { asked: true, reply: await work() };
    } catch (error) {
      // `String(error)` RATHER THAN A TERNARY ON `instanceof Error`, which is what
      // `presence.ts:241` does and what the coverage ratchet asked for: the
      // non-Error arm is unreachable from any test and a branch nothing can take is
      // a branch to delete. `String` on an Error yields "Error: …", one word longer
      // than `.message` and never absent.
      logger.log("error", "connections.failed", { op, detail: String(error) });
      return { asked: false };
    }
  }

  /** Walk the slots, claiming the first free one.
   *
   * **`SET NX` IS THE ATOMICITY AND THAT IS THE WHOLE ARGUMENT** (FR-013). Two
   * connections racing for one slot cannot both win it: the loser's `NX` returns
   * nil and it walks to the next. When all five are held both correctly refuse.
   * The race is settled by the command rather than by a check-then-act, which is
   * why no Lua is needed here.
   *
   * **TWO COMMANDS PER CONTESTED SLOT, AND THE SECOND ONE IS A BUG FIX.** A
   * tombstone means the previous holder let the place go, so it is free — and the
   * first version of this walk stepped over it, because `NX` refuses any key that
   * exists. One slot briefly skipped is harmless and the release's comment said so.
   * `releaseAll` tombstones ALL FIVE AT ONCE, and then the walk found nothing free
   * and refused a connection with `connection_limit_reached` — a close code whose
   * documented remedy is "close one of the connections you already hold", which a
   * client reconnecting after a deploy cannot do: they went with the old instance.
   *
   * Found as a 2-in-6 flake in the clean-shutdown test, whose first message —
   * `no connection.ack within 5s` — was true of a socket that had been refused 4004
   * half a second earlier. Widening the tombstone to 500 ms turns it from a flake
   * into a test.
   *
   * `IFEQ TOMBSTONE` keeps the race settled inside the command: two connections
   * both finding the tombstone both attempt it, the first wins, the second's
   * comparison now fails against the winner's id and it walks on. No connection id
   * can equal `-`, so this can never take a live place. */
  async function walk(
    environmentId: string,
    user: string,
    connectionId: string,
  ): Promise<ClaimOutcome> {
    for (let slot = 0; slot < MAX_CONNECTIONS_PER_USER; slot += 1) {
      const k = key(environmentId, user, slot);
      // BOTH COMMANDS UNDER ONE `failable`, and that is the coverage ratchet's
      // doing. Two wrappers meant two "could not ask" arms, and the second was
      // unreachable: for it to fire, Redis would have to die between a command that
      // answered and the next one. One wrapper has one failure path, and the arm
      // that nothing could take is gone rather than covered.
      const got = await failable("claim", async () => {
        const free = await client.set(k, connectionId, "PX", boundMs, "NX");
        // `null` HERE MEANS THE SLOT IS TAKEN, which is arm 1 and not arm 5.
        if (free === "OK") return free;
        return await setIfEq(k, connectionId, TOMBSTONE, boundMs);
      });
      if (!got.asked) return { kind: "unenforced" };
      if (got.reply === "OK") return { kind: "claimed", slot, held: slot };
    }
    return { kind: "full", held: MAX_CONNECTIONS_PER_USER };
  }

  return {
    claim: walk,

    /** **`IFEQ`, NEVER `XX`, and this was a corrected decision.** `XX` tests that
     * the key exists and nothing more — measured on Redis 8.10.0, `SET k B XX`
     * against a key holding `A` returns OK and the value becomes B. So a connection
     * whose slot expired during an outage would come back, find the slot re-claimed,
     * and silently take it: six connections against a count of five, FR-001 and
     * FR-011 both violated. `IFEQ` compares before writing and is refused both when
     * the key holds another id and when the key is gone. */
    renew: async (environmentId, user, connectionId, slot) => {
      const asked = await failable("renew", () =>
        setIfEq(key(environmentId, user, slot), connectionId, connectionId, boundMs),
      );
      if (!asked.asked) return { kind: "unenforced" };
      if (asked.reply === "OK") return { kind: "renewed" };
      // Refused: the key is gone, or somebody else holds it. Either way this
      // connection has lost its place and FR-011b says what happens next — one
      // more attempt to claim, because after a brief outage nothing else took the
      // slot and closing the connection would cost a user their place for Redis's
      // downtime.
      const again = await walk(environmentId, user, connectionId);
      if (again.kind === "claimed") return { kind: "reclaimed", slot: again.slot };
      // RETURNED WHOLE, because `full` and `unenforced` mean here exactly what they
      // mean there. Re-wrapping them cost two branches and one of them was
      // unreachable — the walk can only answer `unenforced` if Redis stopped
      // answering between this renewal and it. `full` now carries `held` for the
      // same reason a claim's does: the caller logs the number.
      return again;
    },

    /** A one-millisecond tombstone, written only if the slot is still ours.
     *
     * **NOT `DEL`, which has no ownership check** — the same hole `IFEQ` closed on
     * the renewal, on the path that fix introduced. A connection whose slot expired
     * and was re-claimed would `DEL` the new owner's key and free a place that is
     * in use. `SET key - IFEQ id PX 1` refuses that.
     *
     * THIS COMMENT USED TO SAY the millisecond fails in the safe direction — a
     * claim arriving inside it finds the key present, its `NX` fails, and it walks
     * to the next slot; one slot briefly skipped, never an over-admit. True of one
     * slot and false of five, which is what `releaseAll` writes. The walk above now
     * claims a tombstoned slot instead of stepping over it, so the window is not a
     * window any more. `GETDEL` exists and is unconditional, so it is no use
     * here. */
    release: async (environmentId, user, connectionId, slot) => {
      await failable("release", () =>
        setIfEq(key(environmentId, user, slot), TOMBSTONE, connectionId, tombstoneMs),
      );
    },

    releaseAll: async (held) => {
      for (const one of held) {
        await failable("releaseAll", () =>
          setIfEq(
            key(one.environmentId, one.user, one.slot),
            TOMBSTONE,
            one.connectionId,
            tombstoneMs,
          ),
        );
      }
    },

    close: async () => {
      await client.quit();
    },
  };
}
