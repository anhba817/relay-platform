import { createLogger, type Logger } from "@relay/service-kit";
import {
  messageSchema,
  revisionFabricSchema,
  subjectForChannel,
  subjectForChannelRevision,
} from "@relay/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMessagePublisher } from "./publisher";

// A fake at the ioredis seam. The publisher's contract is "never rejects", so a
// test that only checks it resolved cannot tell a swallowed failure from a
// success — and cannot tell either from a publisher that does nothing. Every
// assertion below therefore names what it would take to fail.
const publishes: Array<[string, string]> = [];
let throwing = false;
let disconnects = 0;
let errorHandler: ((e: Error) => void) | undefined;
vi.mock("ioredis", () => ({
  Redis: class {
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

const message = {
  id: "m1",
  channel: "c1",
  seq: 1,
  user: "outside-bot",
  text: "hello",
  created_at: "2026-08-27T00:00:00.000Z",
};
const context = { requestId: "req-1", environmentId: "env-1" };

const tombstone = {
  id: "m1",
  channel: "c1",
  seq: 1,
  user: "outside-bot",
  deleted_at: "2026-09-03T00:00:00.000Z",
};

function sink(): { lines: Record<string, unknown>[]; logger: Logger } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger("publisher-test", (line) =>
    lines.push(JSON.parse(line) as Record<string, unknown>),
  );
  return { lines, logger };
}

beforeEach(() => {
  publishes.length = 0;
  throwing = false;
  disconnects = 0;
  errorHandler = undefined;
});

describe("the api's fan-out publisher", () => {
  it("publishes to the channel's subject", async () => {
    const { logger } = sink();
    await createMessagePublisher({ logger }).publish(message, context);
    expect(publishes).toHaveLength(1);
    expect(publishes[0]![0]).toBe(subjectForChannel("c1"));
  });

  it("publishes a payload the delivery side will accept", async () => {
    // The far end parses with `messageCreatedSchema.shape.payload`, a
    // `z.strictObject` of six fields, and DROPS what does not match — so an
    // extra key delivers nothing while the send still returns 201. Asserting
    // against the schema catches a seventh field, a missing `user`, a
    // non-positive `seq` and a `created_at` that is not RFC 3339, in one line.
    const { logger } = sink();
    await createMessagePublisher({ logger }).publish(message, context);
    const parsed = messageSchema.safeParse(JSON.parse(publishes[0]![1]));
    expect(parsed.success).toBe(true);
    expect(Object.keys(JSON.parse(publishes[0]![1])).sort()).toEqual([
      "channel",
      "created_at",
      "id",
      "seq",
      "text",
      "user",
    ]);
  });

  it("resolves when the client throws, and says so in the log", async () => {
    // What would have to be false for this to fail? That the catch exists. The
    // resolution alone proves nothing — a publisher with no body also resolves
    // — so the log line is the assertion that carries FR-010 and FR-011.
    throwing = true;
    const { lines, logger } = sink();
    await expect(
      createMessagePublisher({ logger }).publish(message, context),
    ).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]!["msg"]).toBe("fanout.publish_failed");
    expect(lines[0]!["level"]).toBe("error");
    // NFR-OBS-01's two fields, and NFR-OBS-06's five-minute traceability.
    expect(lines[0]!["request_id"]).toBe("req-1");
    expect(lines[0]!["environment_id"]).toBe("env-1");
    expect(lines[0]!["channel"]).toBe("c1");
    expect(lines[0]!["message_id"]).toBe("m1");
  });

  it("does not touch the client again inside the down-window", async () => {
    // T009b. The window is what makes a dead Redis cheap rather than merely
    // survivable: without it every send pays the connect timeout, which is
    // `limits/store.ts`'s recorded mistake — "each request paid a second or
    // more, twice".
    //
    // The assertion is that the client is NOT CALLED, not that the publish
    // resolved: it resolves either way, window or no window.
    throwing = true;
    const { lines, logger } = sink();
    let clock = 1_000;
    const p = createMessagePublisher({ logger, now: () => clock });

    await p.publish(message, context);
    expect(lines).toHaveLength(1); // the first failure opens the window

    clock += 4_999;
    await p.publish(message, context);
    expect(lines).toHaveLength(1); // still one: no attempt, so nothing to log

    clock += 2; // 5_001 ms after the failure — the window has closed
    await p.publish(message, context);
    expect(lines).toHaveLength(2);
  });

  it("publishes a revision to the revision subject, not the channel's", async () => {
    // T018h, chapter 3.23. THE SUBJECT IS THE ASSERTION. A `publishRevision` that reached
    // for `subjectForChannel` would deliver an edit to a subscriber that parses arrivals
    // as `Message` — and the `updated` arm IS a `Message`, so it would be accepted and
    // shown to every member as a brand new message.
    const { logger } = sink();
    await createMessagePublisher({ logger }).publishRevision(
      { kind: "updated", message },
      context,
    );
    expect(publishes).toHaveLength(1);
    expect(publishes[0]![0]).toBe(subjectForChannelRevision("c1"));
    expect(publishes[0]![0]).not.toBe(subjectForChannel("c1"));
  });

  it("publishes revision payloads the delivery side will accept", async () => {
    // The same test `publish` has above, and for the same reason: this side serialises and
    // the gateway parses, and nothing in the type system connects the two. Both arms,
    // because the deleted one is the one that cannot be a `Message`.
    const { logger } = sink();
    const p = createMessagePublisher({ logger });
    await p.publishRevision({ kind: "updated", message }, context);
    await p.publishRevision({ kind: "deleted", message: tombstone }, context);

    const parsedEdit = revisionFabricSchema.safeParse(JSON.parse(publishes[0]![1]));
    expect(parsedEdit.success).toBe(true);
    const parsedDeletion = revisionFabricSchema.safeParse(JSON.parse(publishes[1]![1]));
    expect(parsedDeletion.success).toBe(true);
    expect(parsedDeletion.success && parsedDeletion.data.kind).toBe("deleted");
  });

  it("shares one down-window with `publish`, because one Redis is down for both", async () => {
    // The falsifiable half of the down-window decision. Two windows — one per method —
    // would let a failed `publish` be followed immediately by a `publishRevision` that
    // pays the connect timeout on the request path, which is the cost the window exists to
    // avoid. The assertion is that the client is NOT called: it resolves either way.
    throwing = true;
    const { lines, logger } = sink();
    let clock = 1_000;
    const p = createMessagePublisher({ logger, now: () => clock });

    await p.publish(message, context);
    expect(lines).toHaveLength(1); // `publish` opened the window

    await p.publishRevision({ kind: "updated", message }, context);
    expect(lines).toHaveLength(1); // the revision saw it and made no attempt

    clock += 5_001; // the window has closed for both
    await p.publishRevision({ kind: "deleted", message: tombstone }, context);
    expect(lines).toHaveLength(2);
    expect(lines[1]!["msg"]).toBe("fanout.publish_failed");
    expect(lines[1]!["kind"]).toBe("deleted");
    expect(lines[1]!["message_id"]).toBe("m1");
  });

  it("survives an ioredis `error` event instead of dying on it", () => {
    // R10, and the reason this listener exists at all. Without one, ioredis
    // emits `error` on an EventEmitter with no listener and Node turns that
    // into an unhandled exception — the api would die for the thing it is built
    // to survive. `createFanout` in the gateway has no such listener.
    const { lines, logger } = sink();
    createMessagePublisher({ logger });
    expect(errorHandler).toBeTypeOf("function");
    expect(() => errorHandler!(new Error("ECONNREFUSED"))).not.toThrow();
    // Deliberately silent: the failure that matters is a failed PUBLISH, which
    // has its own line. A connection-level error on every retry would be noise.
    expect(lines).toHaveLength(0);
  });

  it("falls back to the documented default when RELAY_REDIS_URL is unset", async () => {
    // The coverage pin found this one. Every other test either passes `url` or
    // runs with the lane's env set, so the `??` fallback was never taken — 100%
    // of statements, functions and lines, and 5 of 6 branches. The number that
    // caught it is the one chosen from the requirement rather than from a report.
    const saved = process.env["RELAY_REDIS_URL"];
    delete process.env["RELAY_REDIS_URL"];
    try {
      const { logger } = sink();
      await createMessagePublisher({ logger }).publish(message, context);
      // It published, which means it resolved a URL — and the only URL left is
      // `DEFAULT_FANOUT_REDIS_URL`. The mocked client accepts any.
      expect(publishes).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env["RELAY_REDIS_URL"];
      else process.env["RELAY_REDIS_URL"] = saved;
    }
  });

  it("disconnects on close", async () => {
    // Not a formality. `limits/limits.module.ts:10` states the api's convention —
    // "resource in this api closes through `OnModuleDestroy`" — and a `close()`
    // that nothing calls is a leaked handle in a service that boots once per
    // integration suite. The coverage pin for this file requires 100% of
    // functions precisely so this cannot go untested.
    const { logger } = sink();
    await createMessagePublisher({ logger }).close();
    expect(disconnects).toBe(1);
  });

  it("closes the window after a success", async () => {
    const { lines, logger } = sink();
    let clock = 1_000;
    const p = createMessagePublisher({ logger, now: () => clock });
    throwing = true;
    await p.publish(message, context);
    throwing = false;
    clock += 6_000;
    await p.publish(message, context); // succeeds, clears downUntil
    clock += 1;
    throwing = true;
    await p.publish(message, context); // must attempt, and fail, and log
    expect(lines).toHaveLength(2);
    expect(publishes).toHaveLength(1);
  });
});
