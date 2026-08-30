import { randomUUID } from "node:crypto";

import { createLogger, type Logger } from "@relay/service-kit";
import {
  subjectForChannelMembership,
  subjectForUserMembership,
  type MembershipFabric,
} from "@relay/protocol";
// A CLIENT BELONGING TO NEITHER SIDE. The gateway module only subscribes and the
// api's publisher lives in another package, so a test that wants to put a frame on
// the fabric needs its own publisher. `presence.itest.ts` carries the same one for
// the same reason and `eslint.config.mjs` carries the exemption.
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMembership,
  DEFAULT_REREAD_INTERVAL_MS,
  type Membership,
} from "./membership.js";

// Chapter 3.20, phase 3 — the fabric, and ONLY the fabric.
//
// **THE ARMS THAT `session.ts` CANNOT REACH, WRITTEN NOW.** Chapter 3.19 met its
// equivalents at close-out and its record is the price: six arms of `presence.ts`
// had never executed while thirty-one integration tests and eight unit tests were
// green, and the seven tests written to fix that came with a re-measured battery.
// Every case below is unreachable through a session: a session never unsubscribes
// something it did not subscribe, never receives before its handler is wired, and
// never constructs the module at all.
//
// `fanout.itest.ts` is the shape — a Redis-only integration file with no api and no
// gateway. The two-instance session harness arrives in phase 4 with its first test,
// because a fixture written a phase before its consumer is an unused binding, which
// is what T039 already cost this chapter once.

const url = process.env.RELAY_REDIS_URL ?? "redis://localhost:6379";

interface LogLine {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

/** THE SINK RECEIVES A JSON STRING, not an object, and the fields are spread at the
 * top level rather than nested. Chapter 3.19's first version pushed the raw line, so
 * every `l.msg` was `undefined` and the log assertions matched nothing while passing
 * — the one failure mode a log-based assertion has. The `records a line at all` test
 * below is what proves this helper before anything relies on it (T044). */
function recorder(): { logs: LogLine[]; logger: Logger } {
  const logs: LogLine[] = [];
  const logger = createLogger("membership-itest", (line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    logs.push({
      level: String(parsed["level"]),
      msg: String(parsed["msg"]),
      fields: parsed,
    });
  });
  return { logs, logger };
}

/** Redis pub/sub is fire-and-forget: a test cannot poll a queue, so it waits with a
 * deadline. A timeout here is a real failure — the frame did not cross. */
function waitFor<T>(
  predicate: () => T | undefined,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const value = predicate();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`no ${what} within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Fresh ids per run. Redis pub/sub has no namespaces, so two suites publishing to a
 * fixed subject on one broker read each other's frames — chapter 2.7 paid for this
 * between `fanout.itest.ts` and `resume.itest.ts`, and the only namespace pub/sub
 * has is the subject itself. */
const CHANNEL = randomUUID();
const ENVIRONMENT = randomUUID();

const publisher = new Redis(url);
const modules: Membership[] = [];

/** Every module this file builds, closed after its test. A leaked subscriber holds
 * an open handle and vitest reports it as a hanging suite rather than a failure. */
function build(options: Parameters<typeof createMembership>[0]): Membership {
  const membership = createMembership(options);
  modules.push(membership);
  return membership;
}

function change(overrides: Partial<MembershipFabric> = {}): MembershipFabric {
  return {
    environment: ENVIRONMENT,
    channel: CHANNEL,
    user: "tuan",
    change: "removed",
    ...overrides,
  };
}

beforeEach(() => {
  modules.length = 0;
});

afterEach(async () => {
  await Promise.all(modules.map((m) => m.close()));
});

afterAll(() => {
  publisher.disconnect();
});

describe("the membership fabric carries a change between two processes", () => {
  it("delivers what was published on a channel's subject", async () => {
    const { logger } = recorder();
    const membership = build({ logger });
    const seen: MembershipFabric[] = [];
    membership.onChange((c) => seen.push(c));
    await membership.subscribeChannel(CHANNEL);

    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify(change()),
    );

    const first = await waitFor(() => seen[0], "membership change");
    expect(first).toEqual(change());
  });

  it("delivers on a PRINCIPAL's subject, which no other fabric has", async () => {
    // Research R1's asymmetry, and the reason this grammar has two shapes. A
    // removal can ride the channel subject because the removed user is still a
    // member when it goes out; an ADDITION cannot, because the instance holding the
    // new member is not subscribed to that channel yet. This is the first event in
    // the system addressed to a principal rather than to a channel.
    const { logger } = recorder();
    const membership = build({ logger });
    const seen: MembershipFabric[] = [];
    membership.onChange((c) => seen.push(c));
    await membership.subscribeUser(ENVIRONMENT, "tuan");

    await publisher.publish(
      subjectForUserMembership(ENVIRONMENT, "tuan"),
      JSON.stringify(change({ change: "added" })),
    );

    const first = await waitFor(() => seen[0], "membership change");
    expect(first.change).toBe("added");
  });

  it("stops delivering once the last subscriber unsubscribes", async () => {
    const { logger } = recorder();
    const membership = build({ logger });
    const seen: MembershipFabric[] = [];
    membership.onChange((c) => seen.push(c));
    await membership.subscribeChannel(CHANNEL);
    await membership.unsubscribeChannel(CHANNEL);

    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify(change()),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([]);
  });

  it("keeps delivering while a SECOND subscriber remains (the reference count)", async () => {
    // Research R6's sharp case at the fabric level. Two members of one channel on
    // one instance must not unsubscribe each other, and an implementation that
    // releases the subscription outright passes every test above.
    const { logger } = recorder();
    const membership = build({ logger });
    const seen: MembershipFabric[] = [];
    membership.onChange((c) => seen.push(c));
    await membership.subscribeChannel(CHANNEL);
    await membership.subscribeChannel(CHANNEL);
    await membership.unsubscribeChannel(CHANNEL);

    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify(change()),
    );
    const first = await waitFor(() => seen[0], "membership change");
    expect(first).toEqual(change());
  });
});

describe("the arms a session cannot reach (T036's list)", () => {
  it("ignores an unsubscribe for a channel that was never subscribed", async () => {
    // `counts.get(key) ?? 0` and the early return under it. Chapter 3.19's presence
    // module wrote `?? 1` here, and the coverage ratchet found the arm unreachable
    // through `session.ts` — which is exactly why this test is in this file.
    const { logs, logger } = recorder();
    const membership = build({ logger });
    await expect(
      membership.unsubscribeChannel(randomUUID()),
    ).resolves.toBeUndefined();
    await expect(
      membership.unsubscribeUser(ENVIRONMENT, "nobody"),
    ).resolves.toBeUndefined();
    // Silently, and that is the assertion: an unsubscribe for something absent is a
    // no-op rather than a failure, so nothing is logged and nothing throws.
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("survives a change arriving before onChange is wired", async () => {
    // The no-op default. `main.ts` builds the module before `attachSessions` runs,
    // so there is a real window where a frame can arrive with no handler behind it —
    // narrow, and the process dies if it is unhandled.
    const { logger } = recorder();
    const membership = build({ logger });
    await membership.subscribeChannel(CHANNEL);
    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify(change()),
    );
    await new Promise((r) => setTimeout(r, 300));

    // AND THEN IT STILL WORKS, which is the assertion. "It got here" is the weaker
    // claim and was this test's first version: an `expect(true).toBe(true)` under a
    // title about survival proves survival only by the absence of a crash, and the
    // absence of a crash is equally true of a module that stopped listening. Wiring
    // a handler afterwards and receiving on the SAME subscription proves the
    // connection, the subscription and the listener all outlived the dropped frame.
    const seen: MembershipFabric[] = [];
    membership.onChange((c) => seen.push(c));
    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify(change({ user: "linh" })),
    );
    const first = await waitFor(() => seen[0], "the change after the handler");
    expect(first.user).toBe("linh");
    // And the dropped one is gone rather than replayed — there is no queue here.
    expect(seen).toHaveLength(1);
  });

  it("logs membership.invalid_payload for a body that is not JSON", async () => {
    // **AND THE TITLE NAMES WHAT THE ASSERTION CHECKS.** Chapter 3.19 shipped
    // "logs presence.invalid_payload for a payload that is not a transition"
    // asserting `toEqual([])` — a good test under a false name, with both rejection
    // arms of the module reading zero coverage while it was green.
    const { logs, logger } = recorder();
    const membership = build({ logger });
    await membership.subscribeChannel(CHANNEL);
    await publisher.publish(subjectForChannelMembership(CHANNEL), "{not json");

    const line = await waitFor(
      () => logs.find((l) => l.msg === "membership.invalid_payload"),
      "invalid_payload line",
    );
    // T044's proof, taken before anything else relies on the mechanism: `msg` is a
    // real string and the fields are at the top level, not nested.
    expect(line.level).toBe("error");
    expect(line.fields["subject"]).toBe(subjectForChannelMembership(CHANNEL));
  });

  it("logs membership.invalid_payload for JSON the fabric schema rejects", async () => {
    // The SECOND rejection arm, and a separate test because the first cannot reach
    // it: valid JSON gets past `JSON.parse` and dies at `safeParse`. An unknown
    // field is refused rather than stripped — `membershipFabricSchema` is a
    // `strictObject`, and this is the frame that proves it on the receive side.
    const { logs, logger } = recorder();
    const membership = build({ logger });
    await membership.subscribeChannel(CHANNEL);
    await publisher.publish(
      subjectForChannelMembership(CHANNEL),
      JSON.stringify({ ...change(), sneaky: true }),
    );

    const line = await waitFor(
      () => logs.find((l) => l.msg === "membership.invalid_payload"),
      "invalid_payload line",
    );
    expect(line.level).toBe("error");
  });

  it("closes cleanly with a re-read timer armed", async () => {
    const { logger } = recorder();
    const membership = build({ logger });
    let reads = 0;
    membership.watch(async () => {
      reads += 1;
    });
    await expect(membership.close()).resolves.toBeUndefined();
    // Closed before the interval elapsed, so nothing ran — and nothing may run
    // after. A timer surviving `close()` is how chapter 3.19 leaked one suite's
    // work into the next file.
    await new Promise((r) => setTimeout(r, 150));
    expect(reads).toBe(0);
  });

  it("cancels one watcher without cancelling the others", async () => {
    const { logger } = recorder();
    const membership = build({ logger, rereadIntervalMs: 40 });
    let a = 0;
    let b = 0;
    const cancel = membership.watch(async () => {
      a += 1;
    });
    membership.watch(async () => {
      b += 1;
    });
    cancel();
    await waitFor(() => (b > 1 ? b : undefined), "the second watcher to run twice");
    // A connection that closes must stop asking, and must not stop anyone else
    // asking. One `clearInterval` over a shared timer would fail this.
    expect(a).toBe(0);
  });

  it("logs a re-read that throws, and keeps the timer running", async () => {
    // FR-015: a membership-path failure must not fail a connection. The log line is
    // the evidence — a `watch` that swallowed and then stopped scheduling would
    // satisfy "nothing crashed" exactly as well.
    const { logs, logger } = recorder();
    const membership = build({ logger, rereadIntervalMs: 40 });
    let attempts = 0;
    membership.watch(async () => {
      attempts += 1;
      throw new Error("the api said no");
    });
    await waitFor(() => (attempts > 1 ? attempts : undefined), "a second attempt");
    const line = logs.find((l) => l.msg === "membership.failed");
    expect(line?.fields["op"]).toBe("reread");
    expect(String(line?.fields["error"])).toContain("the api said no");
  });

  it("takes both defaults when neither is supplied", async () => {
    // THE ARM NO OTHER TEST TAKES, and the reason it needs naming: every test above
    // passes a url or an interval, so `url ?? DEFAULT_REDIS_URL` and
    // `rereadIntervalMs ?? DEFAULT_REREAD_INTERVAL_MS` both read zero without this.
    // Chapter 3.19's identical case measured `[15, 0]` and needed a test written at
    // close-out purely to take the fallback.
    const saved = process.env["RELAY_REDIS_URL"];
    delete process.env["RELAY_REDIS_URL"];
    try {
      const { logger } = recorder();
      const membership = build({ logger });
      const seen: MembershipFabric[] = [];
      membership.onChange((c) => seen.push(c));
      // It subscribed and received, so it resolved a url — and with the environment
      // variable gone the only one left is `DEFAULT_REDIS_URL`, which the lane's
      // Redis answers on.
      await membership.subscribeChannel(CHANNEL);
      await publisher.publish(
        subjectForChannelMembership(CHANNEL),
        JSON.stringify(change()),
      );
      await waitFor(() => seen[0], "membership change on the default url");
      // And the interval default came with it, unmeasurable any other way: sixty
      // seconds cannot be waited out in a package whose whole clock is forty-five.
      expect(DEFAULT_REREAD_INTERVAL_MS).toBe(60_000);
    } finally {
      if (saved === undefined) delete process.env["RELAY_REDIS_URL"];
      else process.env["RELAY_REDIS_URL"] = saved;
    }
  });

  it("logs an ioredis connection error rather than dying on it", async () => {
    // The `error` listener, reachable only by pointing the module at nothing. Its
    // stated reason is NFR-OBS-01 rather than process death: chapter 3.18 measured
    // ioredis 6.0.0 and the process survives an unlistened `error`, printing
    // `[ioredis] Unhandled error event: …` itself — unstructured and unbounded.
    const { logs, logger } = recorder();
    build({ logger, url: "redis://127.0.0.1:1" });
    const line = await waitFor(
      () => logs.find((l) => l.msg === "membership.failed"),
      "a connection error line",
    );
    expect(line.fields["op"]).toBe("connection");
  });
});
