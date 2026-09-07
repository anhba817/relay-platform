import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createConnections,
  DEFAULT_BOUND_MS,
  DEFAULT_HEARTBEAT_MS,
  MAX_CONNECTIONS_PER_USER,
} from "./connections.js";

// The connection-cap chapter's slot registry — THE HALF THAT NEEDS NO BROKER (feature 043: FR-006,
// FR-006a, FR-024, FR-024a).
//
// This file held all seventeen of the registry's tests and twelve of them talk to a real
// Redis. It is a `.test.ts`, so it runs in the lane chapter 2.1 built specifically to
// need no containers — the lane whose whole point is that `pnpm test` is honest on a
// laptop with nothing running. With the stack down it reported twelve failures that were
// correct behaviour, and `gaps.md` 3.23-9 has carried that since it was found by
// accident.
//
// **WHICH FIVE STAY WAS MEASURED, NOT ARGUED.** Run the original against a dead broker
// and it reports `12 failed | 5 passed`:
//
//   RELAY_REDIS_URL=redis://127.0.0.1:6399 vitest run src/connections.test.ts
//
// Research predicted two and the measurement found five. The heartbeat test was filed
// under "asserts registry behaviour" on the strength of its title; it asserts a ratio
// between two constants and never reaches the broker. **A title is not an inventory of
// what a test touches** — the same defect as a task id in a test title, one category
// over.
//
// AND THE SHARED `beforeEach` IS GONE. The describe these came from built a registry
// against `REDIS` for every test in it, including the two that provably need none. It
// did not break them — `createConnections` connects lazily, which one command settled
// after a reading of the code said otherwise — but a container-free lane holding a Redis
// client it never uses is a lane that will grow one that matters.
//
// The twelve that need a broker are in `connections.itest.ts`, unchanged in behaviour.

const REDIS = process.env["RELAY_REDIS_URL"] ?? "redis://localhost:6379";
const silent = { log: () => {} };

/** A per-run environment, so nothing here collides with the two integration files
 * that share a constant `"env-1"` and both lean on the user name "tuan". */
const ENV = `env-${randomUUID()}`;

describe("the slot registry, without a broker", () => {
  /** A registry and a user per test, not a shared hook. The two below need the OBJECT
   * and not the broker: `release` on a slot never held and `releaseAll([])` both settle
   * before any command is sent. */
  const registryFor = () => createConnections({ url: REDIS, logger: silent });
  const userFor = () => `u-${randomUUID()}`;


  it("does not throw for a slot the connection never held", async () => {
    // ARM 7, AND THE TITLE SAYS ONLY WHAT THE ASSERTION PROVES. It used to read
    // "is a no-op", which claims more: a no-op is a statement about the key, and
    // `resolves.toBeUndefined()` is a statement about the promise. The stronger
    // property is not observable through this module's own surface — a claim walks
    // from slot 0, so whatever an unconditional release did to slot 3 cannot be
    // seen from here — and the ownership half of it is the test below. Chapter
    // The membership-revocation chapter's rule: a claim about an observable difference needs falsifying before
    // the test is written.
    await expect(
      registryFor().release(ENV, userFor(), randomUUID(), 3),
    ).resolves.toBeUndefined();
  });

  it("does not throw when it holds nothing", async () => {
    // ARM 8: the empty loop, which is the shutdown path of an instance that never
    // had a connection. Renamed for the same reason as the test above — "releases
    // nothing" describes the keys and the assertion describes the promise.
    await expect(registryFor().releaseAll([])).resolves.toBeUndefined();
  });

  // ---- ARM 5 and ARM 11: the registry cannot be reached -----------------

  it("returns unenforced rather than zero when Redis is unreachable (FR-016)", async () => {
    // ARM 5 and ARM 11. A port nothing listens on, so every command rejects.
    //
    // `null` MEANS COULD NOT ASK, and the distinction is the requirement: FR-016
    // accepts the connection and logs that the cap was not enforced, which is a
    // different fact from a user being under the limit. Conflating them is what
    // The fan-out chapter found in the fan-out — "the send returned 201 while Redis was
    // down" is true of a publisher that does nothing at all.
    const lines: Record<string, unknown>[] = [];
    const gone = createConnections({
      url: "redis://127.0.0.1:6399",
      logger: {
        log: (_level: string, msg: string, fields?: Record<string, unknown>) => {
          lines.push({ msg, ...fields });
        },
      },
      boundMs: 60,
    });
    expect(await gone.claim(ENV, userFor(), randomUUID())).toEqual({
      kind: "unenforced",
    });
    expect(lines.some((l) => l["msg"] === "connections.failed")).toBe(true);
    await gone.close().catch(() => {});
  }, 20_000);

  // ---- FR-009 and FR-002: the numbers, and where they live --------------

  it("keeps the heartbeat strictly inside the bound, three to one (FR-009)", async () => {
    // THE RATIO, NOT THE VALUES. A test pinning 20_000 and 60_000 goes red on a
    // deliberate re-derivation and says nothing about the property. What FR-009
    // requires is that two consecutive missed renewals cannot free a live
    // connection's place, and three-to-one is what delivers it.
    expect(DEFAULT_HEARTBEAT_MS).toBeLessThan(DEFAULT_BOUND_MS);
    expect(DEFAULT_BOUND_MS / DEFAULT_HEARTBEAT_MS).toBeGreaterThanOrEqual(3);
    // And it is NOT the protocol keepalive, which the presence chapter paid for conflating.
    expect(DEFAULT_HEARTBEAT_MS).not.toBe(30_000);
  });

  it("states the maximum in exactly one place (FR-002)", async () => {
    // The requirement is about DRIFT, not about the value. `policy.ts` derived
    // `connect: 3_000` from "ten thousand divided by five" and shipped a third
    // number; a second literal five in this module is how the same thing starts.
    //
    // Read from disk rather than reasoned about: the module's own source is the
    // only thing that can answer "how many fives are in it".
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "connections.ts"), "utf8");
    const body = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*"))
      .filter((line) => !line.trimStart().startsWith("//"))
      .filter((line) => !line.trimStart().startsWith("/*"))
      .join("\n");
    const fives = body.match(/(?<![\w.])5(?![\w.])/g) ?? [];
    expect(fives, `bare 5 outside comments: ${fives.length}`).toHaveLength(1);
    expect(MAX_CONNECTIONS_PER_USER).toBe(5);
  });
});
