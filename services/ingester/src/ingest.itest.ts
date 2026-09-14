import { AckPolicy, connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "@relay/service-kit";

import { createClickHouse } from "./clickhouse.js";
import { ingestOnce } from "./ingest.js";

// THE REDELIVERY TEST, AND IT FORCES THE REGROUPING.
//
// Constitution VI names idempotency for 100% branch coverage, and the redelivery IS this
// service's idempotency. A demonstration proves the system behaves once; this proves the
// branch that makes it behave is exercised.
//
// It replays the batch under a DIFFERENT max_messages, because replaying the same shape
// proves only the easy half -- and the design this replaced passed that half. JetStream
// hands a retry back as a different set: a batch of 1,2,3,4,5 retried at max_messages=10
// came back 4,5,1,2,3,6,7,8,9,10, out of order and interleaved with newer messages.

const STREAM = "ITEST_INGEST";
const DURABLE = "itest-ingester";
const ENV = "9f000000-0000-4000-8000-00000000feed";
const logger = createLogger("ingest-itest");
const store = createClickHouse();

let nc: NatsConnection;

const record = (n: number): Record<string, unknown> => ({
  environment_id: ENV,
  delivery_id: `9f000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  endpoint_id: "9f000000-0000-4000-8000-0000000000e1",
  event_id: "9f000000-0000-4000-8000-0000000000e2",
  attempt: 1,
  attempted_at: new Date(Date.UTC(2026, 8, 14, 12, 0, n)).toISOString(),
  status: 200,
  latency_ms: 10 + n,
  outcome: "delivered",
});

/** A store that refuses every insert, so nothing is acknowledged and everything comes back. */
const refusing = {
  insert: async (): Promise<void> => {
    throw new Error("store down");
  },
  count: async (): Promise<number> => 0,
};

const rowsForEnv = async (): Promise<number> =>
  Number(
    await fetch(
      `http://localhost:${process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123"}/`,
      {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from("relay:relay").toString("base64") },
        body: `SELECT count() FROM relay_analytics.webhook_attempts FINAL
                 WHERE environment_id = toUUID('${ENV}')`,
      },
    ).then((r) => r.text()),
  );

beforeAll(async () => {
  nc = await connect({ servers: process.env["RELAY_NATS_URL"] ?? "nats://localhost:4222" });
  const jsm = await nc.jetstreamManager();
  await jsm.streams.delete(STREAM).catch(() => undefined);
  await jsm.streams.add({ name: STREAM, subjects: ["itest.ingest.>"] });
  await jsm.consumers.add(STREAM, {
    durable_name: DURABLE,
    ack_policy: AckPolicy.Explicit,
    ack_wait: 1_000_000_000,
    max_deliver: -1,
  });
  const js = nc.jetstream();
  for (let n = 1; n <= 10; n++) {
    await js.publish("itest.ingest.x", new TextEncoder().encode(JSON.stringify(record(n))));
  }
});

afterAll(async () => {
  const jsm = await nc.jetstreamManager();
  await jsm.streams.delete(STREAM).catch(() => undefined);
  // Clean up the probe's rows before anything else counts them.
  await fetch(`http://localhost:${process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123"}/`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from("relay:relay").toString("base64") },
    body: `DELETE FROM relay_analytics.webhook_attempts WHERE environment_id = toUUID('${ENV}')`,
  });
  await nc.close();
});

describe("a redelivery does not become a second row", () => {
  it("writes the batch, then survives a REGROUPED replay of it", async () => {
    expect(await rowsForEnv()).toBe(0);

    // 1. A batch of five is offered and the store refuses, so nothing is acknowledged.
    const refused = await ingestOnce({
      nc, store: refusing, logger, batchRows: 5, batchMs: 1000, stream: STREAM, durable: DURABLE,
    }).catch(() => null);
    expect(refused).toBeNull();
    expect(await rowsForEnv()).toBe(0);

    // 2. ack_wait expires and the same records come back -- cut differently, which is the
    //    case the token design could not survive.
    await new Promise((r) => setTimeout(r, 1500));
    const first = await ingestOnce({
      nc, store, logger, batchRows: 3, batchMs: 1000, stream: STREAM, durable: DURABLE,
    });
    expect(first.written).toBeGreaterThan(0);

    // 3. Drain whatever is left, at yet another size.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      await ingestOnce({
        nc, store, logger, batchRows: 10, batchMs: 1000, stream: STREAM, durable: DURABLE,
      });
    }

    // Ten distinct records, however they were grouped, is ten rows.
    expect(await rowsForEnv()).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// THE RECORD THIS CONSUMER DOES NOT WRITE (chapter 4.4).
//
// Its own stream, because the suite above asserts a whole-table count for its environment
// and a second suite publishing into the same one would be the neighbour problem 045 spent
// a feature on.
//
// What this proves is a NEGATIVE with a positive control beside it: the unknown record is
// still there on the second pass, the malformed one is not, and the attempt was written.
// Without the attempt in the batch, "nothing was written" would also pass with a broken
// consumer.
// ---------------------------------------------------------------------------
const OTHER = "ITEST_INGEST_ROUTE";
const OTHER_DURABLE = "itest-route";

describe("a record of an unrecognised type is left on the stream", () => {
  it("acks the attempt, terminates the malformed, and leaves the unknown", async () => {
    const jsm = await nc.jetstreamManager();
    await jsm.streams.delete(OTHER).catch(() => undefined);
    await jsm.streams.add({ name: OTHER, subjects: ["itest.route.>"] });
    await jsm.consumers.add(OTHER, {
      durable_name: OTHER_DURABLE,
      ack_policy: AckPolicy.Explicit,
      ack_wait: 1_000_000_000,
      max_deliver: -1,
    });
    const js = nc.jetstream();
    const put = async (o: unknown): Promise<void> => {
      await js.publish("itest.route.x", new TextEncoder().encode(JSON.stringify(o)));
    };
    await put(record(101));                                   // an attempt: written
    await put({ type: "media.scanned", media_id: "m1" });     // not ours: left alone
    await put({ type: "api.request", request_id: "r1" });     // ours, but nothing writes it yet
    await put({ delivery_id: "only-this" });                  // no type, missing fields: poison

    const first = await ingestOnce({
      nc, store, logger, batchRows: 10, batchMs: 1000, stream: OTHER, durable: OTHER_DURABLE,
    });
    expect(first).toEqual({ written: 1, malformed: 1, unclaimed: 2 });

    // Past ack_wait: the two unclaimed records come back. The terminated one does not, and
    // the acknowledged one does not.
    await new Promise((r) => setTimeout(r, 1500));
    const second = await ingestOnce({
      nc, store, logger, batchRows: 10, batchMs: 1000, stream: OTHER, durable: OTHER_DURABLE,
    });
    expect(second).toEqual({ written: 0, malformed: 0, unclaimed: 2 });

    await jsm.streams.delete(OTHER).catch(() => undefined);
  });
});
