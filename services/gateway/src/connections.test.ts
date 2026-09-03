import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createConnections,
  DEFAULT_BOUND_MS,
  DEFAULT_HEARTBEAT_MS,
  MAX_CONNECTIONS_PER_USER,
  type Connections,
} from "./connections.js";

// CHAPTER 3.22 — the slot registry.
//
// AGAINST A REAL REDIS, NOT A STUB, and that is the correctness argument rather
// than a preference. The whole design rests on what `SET … NX` and `SET … IFEQ`
// do: `NX` settles FR-013's race inside the command, and `IFEQ` is what stops a
// returning connection taking a slot somebody else now holds. **A stubbed client
// would pass with a non-atomic implementation, with an `XX` renewal that hijacks,
// and with a `DEL` release that frees another connection's place** — all three of
// which this chapter's analysis passes found and corrected. It would also pass
// against a server that does not support `IFEQ` at all.
//
// That is chapter 3.17's T047c one dimension over: a test that passes with half
// its subject applied.

const REDIS = process.env["RELAY_REDIS_URL"] ?? "redis://localhost:6379";
const silent = { log: () => {} };

/** A per-run environment, so nothing here collides with the two integration files
 * that share a constant `"env-1"` and both lean on the user name "tuan". */
const ENV = `env-${randomUUID()}`;

describe("the slot registry", () => {
  let registry: Connections;
  let user: string;

  beforeEach(() => {
    registry = createConnections({ url: REDIS, logger: silent });
    // A fresh user per test rather than a flush: `FLUSHDB` would delete the keys
    // of every other suite running in parallel, and this package's config sets no
    // `fileParallelism`.
    user = `u-${randomUUID()}`;
  });

  afterAll(async () => {
    await registry.close();
  });

  // ---- ARM 1 and ARM 2: the walk -----------------------------------------

  it("claims the first free slot, and reports how many were held", async () => {
    const first = await registry.claim(ENV, user, randomUUID());
    expect(first).toEqual({ kind: "claimed", slot: 0, held: 0 });

    const second = await registry.claim(ENV, user, randomUUID());
    // ARM 1: `SET NX` missed on slot 0 and the walk moved on.
    expect(second).toEqual({ kind: "claimed", slot: 1, held: 1 });
  });

  it("refuses when every slot is held, and says five (FR-001 (3.22))", async () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      expect((await registry.claim(ENV, user, randomUUID())).kind).toBe("claimed");
    }
    // ARM 2: the walk found no free slot.
    expect(await registry.claim(ENV, user, randomUUID())).toEqual({
      kind: "full",
      held: 5,
    });
  });

  it("counts each environment separately for one user identifier (FR-012 (3.22))", async () => {
    const other = `env-${randomUUID()}`;
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      await registry.claim(ENV, user, randomUUID());
    }
    expect((await registry.claim(other, user, randomUUID())).kind).toBe("claimed");
  });

  // ---- ARM 3 and ARM 9: the renewal, and the re-claim --------------------

  it("renews a slot it still holds (FR-008 (3.22))", async () => {
    const id = randomUUID();
    const claimed = await registry.claim(ENV, user, id);
    if (claimed.kind !== "claimed") throw new Error("expected a slot");
    expect(await registry.renew(ENV, user, id, claimed.slot)).toEqual({
      kind: "renewed",
    });
  });

  it("re-claims when its slot is GONE and nothing else took it (FR-011b (3.22))", async () => {
    // ARM 3 then ARM 9. A short-lived registry so the bound elapses inside a test
    // rather than in a minute: the boundMs option exists for exactly this, the way
    // `membership.ts`'s reread interval does — sixty seconds does not fit in a
    // package whose whole wall clock is forty-five.
    const brief = createConnections({ url: REDIS, logger: silent, boundMs: 60 });
    const id = randomUUID();
    const claimed = await brief.claim(ENV, user, id);
    if (claimed.kind !== "claimed") throw new Error("expected a slot");
    await new Promise((resolve) => setTimeout(resolve, 120));

    // THE COMMON CASE AFTER ANY BRIEF OUTAGE, and the branch a design that closes
    // on every refused renewal gets wrong. The user is under the limit; the slot
    // simply expired.
    expect(await brief.renew(ENV, user, id, claimed.slot)).toEqual({
      kind: "reclaimed",
      slot: 0,
    });
    await brief.close();
  });

  // ---- ARM 4 and ARM 10: the hijack, and the cap genuinely full ----------

  it("refuses to renew a slot ANOTHER connection now holds (FR-011 (3.22))", async () => {
    // ARM 4, and the one test in the chapter that catches `IFEQ` being replaced by
    // `XX`. `XX` tests existence and not ownership — measured on 8.10.0,
    // `SET k B XX` against a key holding `A` returns OK — so under `XX` this
    // renewal would silently take the slot and the count would say five while six
    // connections were open.
    const brief = createConnections({ url: REDIS, logger: silent, boundMs: 60 });
    const mine = randomUUID();
    const claimed = await brief.claim(ENV, user, mine);
    if (claimed.kind !== "claimed") throw new Error("expected a slot");
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Somebody else takes the expired slot, and fills the rest so the re-claim has
    // nowhere to go — ARM 10.
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      await brief.claim(ENV, user, randomUUID());
    }
    expect(await brief.renew(ENV, user, mine, claimed.slot)).toEqual({
      kind: "full",
      held: 5,
    });
    await brief.close();
  });

  // ---- ARM 6, ARM 7 and ARM 8: the release ------------------------------

  it("frees a slot it holds, and the slot is reusable at once (FR-010 (3.22))", async () => {
    const id = randomUUID();
    const claimed = await registry.claim(ENV, user, id);
    if (claimed.kind !== "claimed") throw new Error("expected a slot");
    await registry.release(ENV, user, id, claimed.slot);
    // NO WAIT, AND THE SLOT IS NOT PINNED — because at the default one-millisecond
    // tombstone there are THREE outcomes, not two, and the coverage lane found the
    // third by failing here with `slot: 1` where this assertion had demanded 0.
    //
    //   the tombstone is still there   `SET NX` fails, `SET IFEQ -` takes it -> 0
    //   it expired before the walk     `SET NX` succeeds                     -> 0
    //   it expires BETWEEN the two     both fail, the walk moves on          -> 1
    //
    // The third is a millisecond wide and harmless: a slot is skipped, never
    // over-admitted, and the connection is accepted. What must not happen is a
    // refusal, and that is what this asserts. The determinate version lives in the
    // test below, where the window is held open at 500 ms so it cannot race.
    //
    // This test's FIRST version slept 20 ms and accepted any slot; the sleep is
    // what hid the `releaseAll` defect for two phases. Removing the sleep was
    // right and pinning the slot with it was not — the two changes arrived
    // together and only one of them was justified.
    const again = await registry.claim(ENV, user, randomUUID());
    expect(again.kind).toBe("claimed");
    if (again.kind !== "claimed") throw new Error("unreachable");
    expect(again.slot, "a released slot cost more than one place").toBeLessThanOrEqual(1);
  });

  it("claims a slot whose tombstone has NOT expired (FR-010 (3.22))", async () => {
    // A HALF-SECOND TOMBSTONE, so the window is a window rather than a coin flip.
    // With the shipped one-millisecond value this test would pass against the
    // broken walk about half the time, which is how the defect survived: two of six
    // runs of the clean-shutdown test, reported as `no connection.ack within 5s`.
    const slow = createConnections({
      url: REDIS,
      logger: silent,
      tombstoneMs: 500,
    });
    const id = randomUUID();
    const claimed = await slow.claim(ENV, user, id);
    if (claimed.kind !== "claimed") throw new Error("expected a slot");
    await slow.release(ENV, user, id, claimed.slot);
    expect(await slow.claim(ENV, user, randomUUID())).toEqual({
      kind: "claimed",
      slot: 0,
      held: 0,
    });
    await slow.close();
  });

  it("accepts a claim immediately after releaseAll frees all five (FR-011a (3.22))", async () => {
    // THE CASE THAT WAS ACTUALLY BROKEN, and it is a deploy. One slot tombstoned is
    // one slot skipped; five tombstoned is a walk that finds nothing free and
    // reports `full` — so a client reconnecting to the new instance is refused with
    // `connection_limit_reached`, and the remedy that close code names is to close
    // one of the connections it already holds. Those went with the old instance.
    const slow = createConnections({
      url: REDIS,
      logger: silent,
      tombstoneMs: 500,
    });
    const held = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      const id = randomUUID();
      const claimed = await slow.claim(ENV, user, id);
      if (claimed.kind !== "claimed") throw new Error("expected a slot");
      held.push({ environmentId: ENV, user, connectionId: id, slot: claimed.slot });
    }
    await slow.releaseAll(held);
    expect(await slow.claim(ENV, user, randomUUID())).toEqual({
      kind: "claimed",
      slot: 0,
      held: 0,
    });
    await slow.close();
  });

  it("does NOT free a slot another connection now holds (FR-010 (3.22))", async () => {
    // ARM 6, and the reason the release is conditional. Under a plain `DEL` this
    // would delete the new owner's key and hand out a place that is in use — the
    // same ownership hole `IFEQ` closed on the renewal, on the path that fix
    // introduced.
    const brief = createConnections({ url: REDIS, logger: silent, boundMs: 60 });
    const mine = randomUUID();
    const claimed = await brief.claim(ENV, user, mine);
    if (claimed.kind !== "claimed") throw new Error("expected a slot");
    await new Promise((resolve) => setTimeout(resolve, 120));

    const theirs = randomUUID();
    const retaken = await brief.claim(ENV, user, theirs);
    expect(retaken).toEqual({ kind: "claimed", slot: 0, held: 0 });

    await brief.release(ENV, user, mine, claimed.slot);
    // Still theirs: the release was refused. Renewing proves it.
    expect(await brief.renew(ENV, user, theirs, 0)).toEqual({ kind: "renewed" });
    await brief.close();
  });

  it("does not throw for a slot the connection never held", async () => {
    // ARM 7, AND THE TITLE SAYS ONLY WHAT THE ASSERTION PROVES. It used to read
    // "is a no-op", which claims more: a no-op is a statement about the key, and
    // `resolves.toBeUndefined()` is a statement about the promise. The stronger
    // property is not observable through this module's own surface — a claim walks
    // from slot 0, so whatever an unconditional release did to slot 3 cannot be
    // seen from here — and the ownership half of it is the test below. Chapter
    // 3.20's rule: a claim about an observable difference needs falsifying before
    // the test is written.
    await expect(
      registry.release(ENV, user, randomUUID(), 3),
    ).resolves.toBeUndefined();
  });

  it("releases every slot this instance holds (FR-011a (3.22))", async () => {
    const held = [];
    for (let i = 0; i < 3; i += 1) {
      const id = randomUUID();
      const claimed = await registry.claim(ENV, user, id);
      if (claimed.kind !== "claimed") throw new Error("expected a slot");
      held.push({ environmentId: ENV, user, connectionId: id, slot: claimed.slot });
    }
    await registry.releaseAll(held);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // All three back, so the next three claims all succeed.
    for (let i = 0; i < 3; i += 1) {
      expect((await registry.claim(ENV, user, randomUUID())).kind).toBe("claimed");
    }
  });

  it("does not throw when it holds nothing", async () => {
    // ARM 8: the empty loop, which is the shutdown path of an instance that never
    // had a connection. Renamed for the same reason as the test above — "releases
    // nothing" describes the keys and the assertion describes the promise.
    await expect(registry.releaseAll([])).resolves.toBeUndefined();
  });

  // ---- ARM 5 and ARM 11: the registry cannot be reached -----------------

  it("returns unenforced rather than zero when Redis is unreachable (FR-016 (3.22))", async () => {
    // ARM 5 and ARM 11. A port nothing listens on, so every command rejects.
    //
    // `null` MEANS COULD NOT ASK, and the distinction is the requirement: FR-016
    // accepts the connection and logs that the cap was not enforced, which is a
    // different fact from a user being under the limit. Conflating them is what
    // chapter 3.18 found in the fan-out — "the send returned 201 while Redis was
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
    expect(await gone.claim(ENV, user, randomUUID())).toEqual({
      kind: "unenforced",
    });
    expect(lines.some((l) => l["msg"] === "connections.failed")).toBe(true);
    await gone.close().catch(() => {});
  }, 20_000);

  // ---- FR-009 and FR-002: the numbers, and where they live --------------

  it("keeps the heartbeat strictly inside the bound, three to one (FR-009 (3.22))", async () => {
    // THE RATIO, NOT THE VALUES. A test pinning 20_000 and 60_000 goes red on a
    // deliberate re-derivation and says nothing about the property. What FR-009
    // requires is that two consecutive missed renewals cannot free a live
    // connection's place, and three-to-one is what delivers it.
    expect(DEFAULT_HEARTBEAT_MS).toBeLessThan(DEFAULT_BOUND_MS);
    expect(DEFAULT_BOUND_MS / DEFAULT_HEARTBEAT_MS).toBeGreaterThanOrEqual(3);
    // And it is NOT the protocol keepalive, which chapter 3.19 paid for conflating.
    expect(DEFAULT_HEARTBEAT_MS).not.toBe(30_000);
  });

  it("builds without a url, from the environment or from the default", async () => {
    // TWO BRANCHES IN ONE LINE, and the ratchet wanted both: the default parameter
    // — which every test above steps over by passing `url` — and the `??` inside
    // it, whose right-hand side the lane can never reach because it always sets
    // `RELAY_REDIS_URL`. `codes.test.ts:128` established the swap-and-restore
    // shape for exactly this; the `finally` is what keeps a failure here from
    // silently pointing every later suite at a different Redis.
    const defaulted = createConnections({ logger: silent });
    const outcome = await defaulted.claim(ENV, `u-${randomUUID()}`, randomUUID());
    expect(outcome.kind).toBe("claimed");
    await defaulted.close();

    const before = process.env["RELAY_REDIS_URL"];
    try {
      delete process.env["RELAY_REDIS_URL"];
      // `DEFAULT_REDIS_URL` is localhost:6379, which is where the lane's Redis is,
      // so this claims a place rather than failing open — and the assertion is that
      // it reached A Redis, not that it reached a particular one.
      const fallback = createConnections({ logger: silent });
      expect((await fallback.claim(ENV, `u-${randomUUID()}`, randomUUID())).kind).toBe(
        "claimed",
      );
      await fallback.close();
    } finally {
      if (before === undefined) delete process.env["RELAY_REDIS_URL"];
      else process.env["RELAY_REDIS_URL"] = before;
    }
  });

  it("states the maximum in exactly one place (FR-002 (3.22))", async () => {
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
