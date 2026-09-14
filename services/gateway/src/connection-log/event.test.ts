import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@relay/service-kit";

import type { Connection } from "../registry.js";
import {
  createConnectionLog,
  recordFor,
  toConnectionEvent,
  type ConnectionPublisher,
  type PublishableRecord,
} from "./event.js";

const ENV = "9f3c1e7a-0b2d-4c8e-9a1f-6d5b4c3a2e10";
const OTHER_ENV = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const CONN = "7c4d2e1f-3a5b-4c6d-8e9f-0a1b2c3d4e5f";

const OPENED_AT = new Date("2026-09-14T12:00:00.000Z");

/** A REAL `Connection`, not an object carrying four invented fields.
 *
 * Every one of the things FR-003 forbids is genuinely on this type: `identity.token` is
 * the bearer token the client presented at connect, `buffer` holds frames, `channelIds`
 * is the channel list, and `socket` is the socket. The probe is only worth running
 * against the shape the shaper is actually handed. */
function connectionFixture(over: Partial<Connection> = {}): Connection {
  return {
    id: CONN,
    identity: {
      environmentId: ENV,
      userExternalId: "person-42",
      token: "eyJhbGciOiJIUzI1NiJ9.SUPER-SECRET-BEARER-TOKEN.sig",
    },
    socket: { readyState: 1 } as never,
    channelIds: new Set(["chan-alpha", "chan-beta"]),
    revisions: { "chan-alpha": 3 },
    missedPings: 0,
    phase: "live",
    buffer: [{ type: "message.created", text: "the text of a private message" }] as never,
    overflowed: false,
    marks: null,
    sendLimit: 100,
    openedAt: OPENED_AT,
    environmentId: ENV,
    ...over,
  } as Connection;
}

function silentLogger(): Logger {
  return { log: vi.fn() } as unknown as Logger;
}

describe("toConnectionEvent names every field", () => {
  it("stamps an open with the connection's own openedAt, not the moment of shaping", () => {
    // FR-005a. `openedAt` is set before the resume and before the ack; a second
    // instant here would make the reconciliation disagree for a third reason.
    const event = toConnectionEvent(connectionFixture(), { kind: "opened" });
    expect(event.ts).toBe("2026-09-14T12:00:00.000Z");
    expect(event.type).toBe("connection.opened");
  });

  it("leaves close_code and duration_ms ABSENT on an open, not empty", () => {
    // 4.4 measured that a column cannot tell an absent field from an empty one, so the
    // producer has to be the thing that is right. `in` rather than a value check: an
    // explicit `undefined` would pass a truthiness test and serialise as a present key.
    const event = toConnectionEvent(connectionFixture(), { kind: "opened" });
    expect("close_code" in event).toBe(false);
    expect("duration_ms" in event).toBe(false);
    expect(JSON.parse(JSON.stringify(event))).not.toHaveProperty("close_code");
  });

  it("carries the close code and the interval's two endpoints on a close", () => {
    const at = new Date(OPENED_AT.getTime() + 2_000);
    const event = toConnectionEvent(connectionFixture(), { kind: "closed", at, code: 1000 });
    expect(event.type).toBe("connection.closed");
    expect(event.close_code).toBe(1000);
    expect(event.duration_ms).toBe(2_000);
    expect(event.ts).toBe(at.toISOString());
  });

  it("reports 2,000 ms where the meter reports two connection-minutes", () => {
    // The published disagreement, asserted rather than described. Open at 00:00:59 and
    // close at 00:01:01 is two seconds of wall clock and TWO calendar minutes touched.
    const opened = new Date("2026-09-14T00:00:59.000Z");
    const at = new Date("2026-09-14T00:01:01.000Z");
    const event = toConnectionEvent(connectionFixture({ openedAt: opened }), {
      kind: "closed",
      at,
      code: 1000,
    });
    expect(event.duration_ms).toBe(2_000);
  });

  it("clamps a close that precedes its open rather than reporting a negative duration", () => {
    const event = toConnectionEvent(connectionFixture(), {
      kind: "closed",
      at: new Date(OPENED_AT.getTime() - 5_000),
      code: 1006,
    });
    expect(event.duration_ms).toBe(0);
  });
});

describe("the allow-list, checked against the object the shaper is handed", () => {
  it("lets no credential, channel list, message content or socket reach the wire", () => {
    const connection = connectionFixture();
    const wire = [
      JSON.stringify(toConnectionEvent(connection, { kind: "opened" })),
      JSON.stringify(
        toConnectionEvent(connection, { kind: "closed", at: new Date(), code: 1000 }),
      ),
    ].join(" ");

    // Four things, each of them genuinely present on `Connection`.
    expect(wire).not.toContain("SUPER-SECRET-BEARER-TOKEN");
    expect(wire).not.toContain("the text of a private message");
    expect(wire).not.toContain("chan-alpha");
    expect(wire).not.toContain("readyState");
    // And the whole key set, so a field added later has to come through this test.
    expect(Object.keys(toConnectionEvent(connection, { kind: "opened" })).sort()).toEqual([
      "connection_id",
      "environment_id",
      "ts",
      "type",
      "user_external_id",
    ]);
  });
});

describe("the subject carries the tenant", () => {
  it("addresses an open and a close to different subjects under one environment", () => {
    const connection = connectionFixture();
    const open = recordFor(toConnectionEvent(connection, { kind: "opened" }));
    const close = recordFor(
      toConnectionEvent(connection, { kind: "closed", at: new Date(), code: 1000 }),
    );
    expect(open.subject).toBe(`analytics.connection.opened.${ENV}`);
    expect(close.subject).toBe(`analytics.connection.closed.${ENV}`);
  });

  it("puts a second tenant's records on a subject the first tenant's filter cannot reach", () => {
    // THE TENANCY BRANCH. Constitution I does not take a demonstration, so this asserts
    // the address rather than showing one.
    const mine = recordFor(
      toConnectionEvent(connectionFixture(), { kind: "opened" }),
    );
    const theirs = recordFor(
      toConnectionEvent(
        connectionFixture({ environmentId: OTHER_ENV }),
        { kind: "opened" },
      ),
    );
    expect(mine.subject).not.toBe(theirs.subject);
    expect(theirs.subject.endsWith(OTHER_ENV)).toBe(true);
  });

  it("refuses an environment id that is not a uuid rather than publishing a wildcard", () => {
    for (const bad of ["", "not-a-uuid", `${ENV}.extra`, "*", ">"]) {
      expect(() =>
        recordFor(toConnectionEvent(connectionFixture({ environmentId: bad }), { kind: "opened" })),
      ).toThrow(/environment id must be a uuid/);
    }
  });

  it("keys deduplication on the record, not on the connection", () => {
    // 3.20 learned this with `{delivery}:{attempt}`: a delivery id alone collapsed
    // seven retries into one message. The same mistake here collapses a close into
    // its open.
    const connection = connectionFixture();
    const open = recordFor(toConnectionEvent(connection, { kind: "opened" }));
    const close = recordFor(
      toConnectionEvent(connection, { kind: "closed", at: new Date(), code: 1000 }),
    );
    expect(open.id).toBe(`${CONN}:opened`);
    expect(close.id).toBe(`${CONN}:closed`);
    expect(open.id).not.toBe(close.id);
  });
});

/** A publisher that fails on demand, and counts. */
function stubPublisher(): ConnectionPublisher & {
  sent: PublishableRecord[];
  failNext: (n: number) => void;
  failAll: boolean;
} {
  const sent: PublishableRecord[] = [];
  let failures = 0;
  const stub = {
    sent,
    failAll: false,
    failNext(n: number) {
      failures = n;
    },
    async publish(record: PublishableRecord): Promise<void> {
      if (stub.failAll || failures > 0) {
        if (!stub.failAll) failures -= 1;
        throw new Error("broker unreachable");
      }
      sent.push(record);
    },
    async close(): Promise<void> {},
  };
  return stub;
}

describe("the buffer", () => {
  it("publishes nothing from the hand-over and everything from the tick", async () => {
    const publisher = stubPublisher();
    const log = createConnectionLog({ publisher, logger: silentLogger(), intervalMs: 1e9 });
    log.opened(connectionFixture());
    log.closed(connectionFixture(), new Date(), 1000);

    expect(publisher.sent).toHaveLength(0);
    expect(log.buffered()).toBe(2);
    await log.flushOnce();
    expect(publisher.sent).toHaveLength(2);
    expect(log.buffered()).toBe(0);
    log.stop();
  });

  it("RETAINS a record whose publish failed and sends it on the next tick", async () => {
    // FR-004e. The meter drops a report that cannot be delivered, with one exception: a
    // closed connection has no next report to repair the loss. EVERY connection event is
    // in that exception, so the exception is this producer's rule.
    const publisher = stubPublisher();
    const log = createConnectionLog({ publisher, logger: silentLogger(), intervalMs: 1e9 });
    publisher.failAll = true;

    log.opened(connectionFixture());
    await log.flushOnce();
    expect(publisher.sent).toHaveLength(0);
    expect(log.buffered()).toBe(1);
    expect(log.dropped()).toBe(0);

    publisher.failAll = false;
    await log.flushOnce();
    expect(publisher.sent).toHaveLength(1);
    expect(log.buffered()).toBe(0);
    log.stop();
  });

  it("keeps exactly the failed records of a partial flush and drops none of the accepted", async () => {
    // FR-004f. One message per record means a flush of N has N answers. Treating a
    // partial failure as total loss discards records the broker accepted; as total
    // success, records it did not.
    const publisher = stubPublisher();
    const log = createConnectionLog({ publisher, logger: silentLogger(), intervalMs: 1e9 });
    for (let i = 0; i < 5; i++) {
      log.opened(connectionFixture({ id: `${CONN.slice(0, 35)}${i}` }));
    }
    publisher.failNext(2);
    await log.flushOnce();

    expect(publisher.sent).toHaveLength(3);
    expect(log.buffered()).toBe(2);
    expect(log.dropped()).toBe(0);

    await log.flushOnce();
    expect(publisher.sent).toHaveLength(5);
    expect(log.buffered()).toBe(0);
    log.stop();
  });

  it("drops at the cap, counts the drop, and keeps the records describing the outage", async () => {
    // T027, run RED: a cap nothing has ever reached is a cap nobody has tested. The
    // buffer can only fill because a failed publish is retained -- with a flush that
    // emptied regardless of outcome this assertion could not be written.
    const logger = silentLogger();
    const publisher = stubPublisher();
    publisher.failAll = true;
    const log = createConnectionLog({
      publisher,
      logger,
      intervalMs: 1e9,
      maxBuffered: 3,
    });

    for (let i = 0; i < 5; i++) {
      log.opened(connectionFixture({ id: `${CONN.slice(0, 35)}${i}` }));
    }
    expect(log.buffered()).toBe(3);
    expect(log.dropped()).toBe(2);
    expect(logger.log).toHaveBeenCalledWith(
      "error",
      "connection_log.buffer_overflow",
      expect.objectContaining({ discarded: expect.any(Number) }),
    );

    // OLDEST FIRST: the two that went are 0 and 1, and what remains describes the
    // outage rather than its beginning.
    publisher.failAll = false;
    await log.flushOnce();
    expect(publisher.sent.map((r) => r.payload.connection_id.slice(-1))).toEqual([
      "2",
      "3",
      "4",
    ]);
    log.stop();
  });

  it("logs one line per flush rather than one per record, carrying no payload", async () => {
    const logger = silentLogger();
    const publisher = stubPublisher();
    publisher.failAll = true;
    const log = createConnectionLog({ publisher, logger, intervalMs: 1e9 });
    for (let i = 0; i < 4; i++) {
      log.opened(connectionFixture({ id: `${CONN.slice(0, 35)}${i}` }));
    }
    await log.flushOnce();

    const failures = (logger.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((c) => c[1] === "connection_log.publish_failed");
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures[0])).not.toContain("SUPER-SECRET");
    expect(JSON.stringify(failures[0])).not.toContain("analytics.connection");
    log.stop();
  });

  it("a flush with nothing buffered touches the publisher at all", async () => {
    const publisher = stubPublisher();
    const spy = vi.spyOn(publisher, "publish");
    const log = createConnectionLog({ publisher, logger: silentLogger(), intervalMs: 1e9 });
    await log.flushOnce();
    expect(spy).not.toHaveBeenCalled();
    log.stop();
  });

  it("neither hand-over throws when the publisher is broken", async () => {
    // T032's unit half: the close handler is documented as the last place that should
    // throw. `closed()` enqueues and returns; nothing it calls can reject.
    const publisher = stubPublisher();
    publisher.failAll = true;
    const log = createConnectionLog({ publisher, logger: silentLogger(), intervalMs: 1e9 });
    expect(() => log.opened(connectionFixture())).not.toThrow();
    expect(() => log.closed(connectionFixture(), new Date(), 1006)).not.toThrow();
    await expect(log.flushOnce()).resolves.toBeUndefined();
    log.stop();
  });
});
