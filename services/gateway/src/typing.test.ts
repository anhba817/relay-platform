import { describe, expect, it } from "vitest";

import { DEFAULT_REDIS_URL } from "./typing.js";

// PURE SURFACE ONLY, and for this module that is one constant.
//
// **T025 asked for "the pure helpers" and this module has none**, which is worth
// saying rather than padding. `presence.ts` exports `graceCheckDelay` and
// `wonTransition` because presence has arithmetic — three thirty-second numbers
// that are three quantities. Typing has no arithmetic at all: the five-second
// expiry belongs to the receiving client and the two-second renewal interval
// lives in `session.ts`, not here. What is left is transport and a reference
// count, and every branch of both needs a client to reach.
//
// So this module's arms are `typing.itest.ts`'s:
//
//     the JSON.parse catch          a body that is not JSON
//     the safeParse rejection       JSON the fabric schema rejects
//     `counts.get(c) ?? 0`          unsubscribe for a channel never subscribed
//     the onSignal no-op default    a signal arriving with no handler wired
//     close() with subscriptions    close while a channel is still held
//     `url ?? DEFAULT_REDIS_URL`    neither supplied
//     the publish failure           the publisher throws — swallowed and logged
//     TWO error listeners           one per client; emit on each to reach both
//
// `createTyping` is not constructed here on purpose: ioredis connects on
// construction, so a unit test that built one would open two sockets to nothing
// and leak them past the file. `limits.test.ts` and `presence.test.ts` are the
// precedent for the boundary, not for the shape.

describe("DEFAULT_REDIS_URL", () => {
  it("is the local store, matching the other three fabrics", () => {
    // Four modules now declare this same default. They agree by copy rather than
    // by import, which is the same call `limits.ts` made about the api's window
    // arithmetic and stated: a constant small enough to duplicate is cheaper
    // duplicated than abstracted (constitution VII).
    expect(DEFAULT_REDIS_URL).toBe("redis://localhost:6379");
  });
});
