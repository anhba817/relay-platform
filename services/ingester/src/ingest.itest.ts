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
  insertRequests: async (): Promise<void> => {
    throw new Error("store down");
  },
  count: async (): Promise<number> => 0,
  countRequests: async (): Promise<number> => 0,
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
    await put({                                               // ours now, and written
      type: "api.request",
      request_id: "77777777-7777-4777-8777-777777777777",
      ts: "2026-09-14T10:00:00.500Z",
      method: "GET",
      status: 200,
      latency_ms: 4,
      principal_kind: "none",
      refused_at: "handler",
    });
    await put({ delivery_id: "only-this" });                  // no type, missing fields: poison

    const first = await ingestOnce({
      nc, store, logger, batchRows: 10, batchMs: 1000, stream: OTHER, durable: OTHER_DURABLE,
    });
    expect(first).toEqual({
      written: 2, writtenAttempts: 1, writtenRequests: 1, malformed: 1, unclaimed: 1,
    });

    // Past ack_wait: the unclaimed record comes back. The terminated one does not, and
    // neither do the two that were written and acknowledged.
    await new Promise((r) => setTimeout(r, 1500));
    const second = await ingestOnce({
      nc, store, logger, batchRows: 10, batchMs: 1000, stream: OTHER, durable: OTHER_DURABLE,
    });
    expect(second).toEqual({
      written: 0, writtenAttempts: 0, writtenRequests: 0, malformed: 0, unclaimed: 1,
    });

    await jsm.streams.delete(OTHER).catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------
// WHAT THE COLUMN CAN AND CANNOT SAY (chapter 4.4).
//
// The contract spends a paragraph on "absent, not empty" and the first draft of the table
// gave `endpoint` a type that could not hold the difference. Two of these three cases are
// indistinguishable under `LowCardinality(String)`, so a test that checks only the third
// passes either way -- which is why all three are here.
// ---------------------------------------------------------------------------
const CH_URL = `http://localhost:${process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123"}/`;
const CH_AUTH = "Basic " + Buffer.from("relay:relay").toString("base64");
const ch = async (sql: string, settings = ""): Promise<string> =>
  fetch(CH_URL + (settings ? `?${settings}` : ""), {
    method: "POST",
    headers: { Authorization: CH_AUTH },
    body: sql,
  }).then((r) => r.text());

describe("the request table keeps absent and empty apart", () => {
  const REQ_ENV = "9f000000-0000-4000-8000-00000000c0de";

  it("stores absent as NULL, an explicit empty string as '', and a template as itself", async () => {
    const base = {
      environment_id: REQ_ENV,
      ts: "2026-09-14T11:00:00.000Z",
      method: "GET",
      status: 200,
      latency_ms: 3,
      principal_kind: "none",
      refused_at: "handler",
      limited_operation: null,
    };
    const rows = [
      { ...base, request_id: "aaaaaaaa-0000-4000-8000-000000000001", endpoint: null },
      { ...base, request_id: "aaaaaaaa-0000-4000-8000-000000000002", endpoint: "" },
      { ...base, request_id: "aaaaaaaa-0000-4000-8000-000000000003", endpoint: "/v1/webhooks" },
    ];
    await store.insertRequests(rows);

    const seen = (
      await ch(`SELECT multiIf(endpoint IS NULL, 'NULL', endpoint = '', 'EMPTY', endpoint)
                  FROM relay_analytics.api_requests FINAL
                 WHERE environment_id = toUUID('${REQ_ENV}')
                 ORDER BY request_id FORMAT TSV`)
    )
      .trim()
      .split("\n");
    expect(seen).toEqual(["NULL", "EMPTY", "/v1/webhooks"]);

    await ch(`DELETE FROM relay_analytics.api_requests
               WHERE environment_id = toUUID('${REQ_ENV}')`);
  });

  // `type` is the router's discriminator and has no column. This is the one place in the
  // design where a spread fails LOUDLY rather than open, and the setting that makes it loud
  // is 048's.
  it("refuses a record forwarded with `type` still on it", async () => {
    const body = JSON.stringify({
      type: "api.request",
      environment_id: REQ_ENV,
      ts: "2026-09-14T11:00:00.000Z",
      request_id: "aaaaaaaa-0000-4000-8000-000000000009",
      endpoint: null,
      method: "GET",
      status: 200,
      latency_ms: 3,
      principal_kind: "none",
      refused_at: "handler",
      limited_operation: null,
    });
    const out = await ch(
      `INSERT INTO relay_analytics.api_requests FORMAT JSONEachRow\n${body}`,
      "input_format_skip_unknown_fields=0&date_time_input_format=best_effort",
    );
    expect(out).toContain("Code: 117");
    expect(out).toContain("Unknown field found while parsing JSONEachRow format: type");
  });
});

// ---------------------------------------------------------------------------
// FR-017 — a redelivered request record does not become a second row.
//
// MERGES ARE STOPPED FOR THE PHYSICAL COUNT. A count taken while a background merge is
// running measures the merge: this feature's own first probe of this behaviour read 2 after
// six inserts and it read as four rows vanishing. 047 learned the same thing about the TTL --
// a row count taken the moment a load finishes shrinks on its own.
// ---------------------------------------------------------------------------
describe("a redelivered request record does not become a second row", () => {
  const RED_ENV = "9f000000-0000-4000-8000-00000000fee1";
  const REQ_ID = "bbbbbbbb-0000-4000-8000-000000000001";

  it("inserts the same record three times and FINAL still says one", async () => {
    await ch(`SYSTEM STOP MERGES relay_analytics.api_requests`);
    try {
      const row = {
        environment_id: RED_ENV,
        ts: "2026-09-14T12:00:00.000Z",
        request_id: REQ_ID,
        endpoint: "/v1/webhooks",
        method: "GET",
        status: 200,
        latency_ms: 1.25,
        principal_kind: "application",
        refused_at: "handler",
        limited_operation: null,
      };
      // Three separate inserts, exactly as three redeliveries of one record would arrive --
      // and deliberately NOT one insert of three rows, which would prove nothing about
      // redelivery.
      for (let i = 0; i < 3; i++) await store.insertRequests([row]);

      const physical = Number(
        await ch(`SELECT count() FROM relay_analytics.api_requests
                   WHERE environment_id = toUUID('${RED_ENV}')`),
      );
      const collapsed = Number(
        await ch(`SELECT count() FROM relay_analytics.api_requests FINAL
                   WHERE environment_id = toUUID('${RED_ENV}')`),
      );
      // Published as a pair. The physical count is the positive control: if it were 1 the
      // test would be measuring an insert that never happened rather than a key that
      // collapses.
      expect(physical).toBe(3);
      expect(collapsed).toBe(1);
    } finally {
      await ch(`SYSTEM START MERGES relay_analytics.api_requests`);
      await ch(`DELETE FROM relay_analytics.api_requests
                 WHERE environment_id = toUUID('${RED_ENV}')`);
    }
  });
});
