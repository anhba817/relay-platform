import { Inject, Injectable } from "@nestjs/common";
import type { Logger } from "@relay/service-kit";

import { LOGGER } from "../logger";
import { windowStart } from "./bucket";
import { createFallbackCounter } from "./fallback";
import { COUNTER_STORE } from "./limits.module";
import { authFailureThreshold, WINDOW_MS } from "./policy";
import { authKey, type CounterStore } from "./store";

// The limiter that counts FAILED AUTHENTICATIONS by source address
// (chapter 3.8, FR-AUT-12, research R3).
//
// THE ONE THAT MUST NOT FAIL OPEN, and that is the chapter's whole argument. The
// tenant limiter serves the request when Redis is gone, because Redis is not a
// source of truth and a cache outage is not a reason to refuse paid traffic. Run
// the same reasoning here and it gives the opposite answer: an unlimited window
// on failed logins is not a degradation, it is a hole.
//
// FAILING CLOSED IS NOT THE ANSWER EITHER — it turns a Redis restart into an
// authentication outage, which is worse than the attack it prevents for every
// customer who is not being attacked. So: an in-process fallback at the same
// threshold, weakening the guarantee from N per window across the fleet to N per
// window per instance. A small multiple rather than infinity.
//
// WHOSE ADDRESS. The client's, not the caller's. A handshake authenticated
// through the gateway reaches the api FROM the gateway, so counting the caller
// would put every customer's failures in one bucket and let one attacker exhaust
// a threshold that then refuses everybody (research R14).

/** Bounded, and the bound is the decision rather than a detail: this map is keyed
 * by attacker-controlled input, so unbounded it would be a memory-exhaustion
 * vector — a fallback that closed a brute-force hole by opening a worse one. */
const FALLBACK_MAX_KEYS = 10_000;

@Injectable()
export class AuthLimiter {
  private readonly fallback = createFallbackCounter({
    windowMs: WINDOW_MS,
    maxKeys: FALLBACK_MAX_KEYS,
  });

  private lastDegradationLog = 0;

  constructor(
    @Inject(COUNTER_STORE) private readonly store: CounterStore,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Count one failed authentication. */
  async recordFailure(address: string): Promise<void> {
    const now = Date.now();
    const key = authKey(address, windowStart(now, WINDOW_MS));
    if ((await this.store.increment(key, now)) === null) {
      this.degradation();
      this.fallback.increment(address, now);
    }
  }

  /** Has this address already spent its allowance?
   *
   * READS WITHOUT COUNTING. A check that also writes would refuse on its own
   * questions, and this one runs on every request that presents a credential —
   * including the valid ones.
   *
   * When the shared store is unreachable it answers from the in-process count,
   * which is the whole point: the guarantee gets weaker, not absent. A key the
   * fallback could not admit answers `true` — refusing an address we cannot track
   * is the safe direction while degraded, and the cap makes that a bounded
   * population rather than everybody. */
  async isOverThreshold(address: string): Promise<boolean> {
    const now = Date.now();
    const threshold = authFailureThreshold();
    const shared = await this.store.get(
      authKey(address, windowStart(now, WINDOW_MS)),
    );
    if (shared !== null) return shared >= threshold;

    this.degradation();
    const local = this.fallback.peek(address, now);
    return local === null ? true : local >= threshold;
  }

  /** One line, rate limited at the logger. A Redis outage under load would
   * otherwise emit one per attempt, which is how one outage becomes two. No
   * credential and no address (NFR-SEC-06); the count of tracked addresses is
   * what an operator actually needs. */
  private degradation(): void {
    const now = Date.now();
    if (now - this.lastDegradationLog < 10_000) return;
    this.lastDegradationLog = now;
    this.logger.log("error", "limits.auth_degraded", {
      detail:
        "counter store unreachable; counting failed authentications in process",
      tracked: this.fallback.size(),
    });
  }
}
