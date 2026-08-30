import { createLogger, type Logger } from "@relay/service-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMembershipPublisher,
  DEFAULT_MEMBERSHIP_REDIS_URL,
} from "./publisher";

// The membership publisher, Docker-free (chapter 3.20).
//
// A FAKE AT THE IOREDIS SEAM, which is `fanout/publisher.test.ts`'s shape and for its
// reason: the contract is "never rejects", so a test that only checks it resolved
// cannot tell a swallowed failure from a success — and cannot tell either from a
// publisher that does nothing at all.
//
// The first draft of this file reached for `publisher.redis` instead. The factory
// closes over its client and exposes no such property, so six of seven tests failed
// against a fake that was never installed — which is what a mock at the seam avoids.
const publishes: Array<[string, string]> = [];
let throwing = false;
let disconnects = 0;
let urls: string[] = [];
let errorHandler: ((e: Error) => void) | undefined;
vi.mock("ioredis", () => ({
  Redis: class {
    constructor(url: string) {
      urls.push(url);
    }
    on(event: string, handler: (e: Error) => void): this {
      if (event === "error") errorHandler = handler;
      return this;
    }
    async publish(subject: string, payload: string): Promise<number> {
      if (throwing) throw new Error("ECONNREFUSED");
      publishes.push([subject, payload]);
      return 1;
    }
    disconnect(): void {
      disconnects += 1;
    }
  },
}));

const CHANGE = {
  environment: "3f2a0000-0000-0000-0000-000000000001",
  channel: "ce419dc5-b06e-441c-ab38-49451f87210e",
  user: "tuan",
  change: "removed" as const,
};

function sink(): { lines: Record<string, unknown>[]; logger: Logger } {
  const lines: Record<string, unknown>[] = [];
  // The sink receives a JSON STRING with its fields spread at the top level, not an
  // object. Chapter 3.19's first version pushed the raw line, so every `msg` was
  // undefined and the log assertions matched nothing while passing.
  const logger = createLogger("membership-test", (line) =>
    lines.push(JSON.parse(line) as Record<string, unknown>),
  );
  return { lines, logger };
}

beforeEach(() => {
  publishes.length = 0;
  throwing = false;
  disconnects = 0;
  urls = [];
  errorHandler = undefined;
});

describe("the membership publisher", () => {
  it("publishes one subject for a removal", async () => {
    const { logger } = sink();
    await createMembershipPublisher({ url: "redis://x", logger }).publish(CHANGE);
    // The removed user is still a member at the moment this goes out, so the
    // channel's subject reaches both audiences at once.
    expect(publishes.map(([s]) => s)).toEqual([`member:${CHANGE.channel}`]);
  });

  it("publishes two for an addition, because one cannot reach the new member", async () => {
    const { logger } = sink();
    await createMembershipPublisher({ url: "redis://x", logger }).publish({
      ...CHANGE,
      change: "added",
    });
    expect(publishes.map(([s]) => s)).toEqual([
      `member:${CHANGE.channel}`,
      `member:${CHANGE.environment}:tuan`,
    ]);
  });

  it("publishes only the user's subject for a ban", async () => {
    const { logger } = sink();
    await createMembershipPublisher({ url: "redis://x", logger }).publish({
      ...CHANGE,
      channel: "*",
    });
    expect(publishes.map(([s]) => s)).toEqual([
      `member:${CHANGE.environment}:tuan`,
    ]);
  });

  it("logs membership.published on the working path", async () => {
    // FR-031. Every log requirement this chapter inherited was about failure, and an
    // operator who can only see the mechanism breaking cannot tell a quiet system
    // from a dead one.
    const { lines, logger } = sink();
    await createMembershipPublisher({ url: "redis://x", logger }).publish(CHANGE);
    const published = lines.filter((l) => l["msg"] === "membership.published");
    expect(published).toHaveLength(1);
    expect(published[0]!["channel"]).toBe(CHANGE.channel);
    expect(published[0]!["user"]).toBe("tuan");
    // No message content and no token (constitution VI).
    expect(JSON.stringify(published[0])).not.toMatch(/token|text/i);
  });

  it("resolves when the client throws, and says so in the log", async () => {
    const { lines, logger } = sink();
    throwing = true;
    const publisher = createMembershipPublisher({ url: "redis://x", logger });
    // FR-016: the write has committed and the outbox row with it. A publish that
    // threw here would undo a route's success for a delivery the backstop repairs.
    await expect(publisher.publish(CHANGE)).resolves.toBeUndefined();
    const failed = lines.filter((l) => l["msg"] === "membership.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!["op"]).toBe("publish");
    // AND NOTHING CLAIMS SUCCESS. A publisher that logged both would satisfy the
    // assertion above while telling an operator the opposite.
    expect(lines.filter((l) => l["msg"] === "membership.published")).toHaveLength(0);
  });

  it("survives an ioredis `error` event instead of dying on it", async () => {
    // Chapter 3.18's test by name. The listener's stated reason is NFR-OBS-01 —
    // unstructured, unbounded output — rather than process death, which 3.18
    // measured against ioredis 6.0.0 and found false.
    const { lines, logger } = sink();
    createMembershipPublisher({ url: "redis://x", logger });
    expect(errorHandler).toBeDefined();
    expect(() => errorHandler!(new Error("ECONNREFUSED"))).not.toThrow();
    const failed = lines.filter(
      (l) => l["msg"] === "membership.failed" && l["op"] === "connection",
    );
    expect(failed).toHaveLength(1);
  });

  it("falls back to the documented default when RELAY_REDIS_URL is unset", async () => {
    // A defaulted parameter is a branch and every other test here passes a url, so
    // this arm reads zero without one. Chapter 3.19's identical case measured [15, 0]
    // and needed a test written at close-out purely to take the fallback.
    const saved = process.env["RELAY_REDIS_URL"];
    delete process.env["RELAY_REDIS_URL"];
    try {
      const { logger } = sink();
      createMembershipPublisher({ logger });
      expect(urls).toEqual([DEFAULT_MEMBERSHIP_REDIS_URL]);
    } finally {
      if (saved !== undefined) process.env["RELAY_REDIS_URL"] = saved;
    }
  });

  it("disconnects on close", async () => {
    // `close()` is a function and the pin is 100% of functions. `limits.module.ts:10`
    // states the convention it serves: "a close() nothing calls is a leaked handle in
    // a service that boots once per integration suite."
    const { logger } = sink();
    await createMembershipPublisher({ url: "redis://x", logger }).close();
    expect(disconnects).toBe(1);
  });
});
