import { describe, expect, it } from "vitest";

import { shape } from "./shape.js";

const valid = {
  delivery_id: "22222222-2222-4222-8222-222222222222",
  endpoint_id: "33333333-3333-4333-8333-333333333333",
  environment_id: "11111111-1111-4111-8111-111111111111",
  event_id: "44444444-4444-4444-8444-444444444444",
  attempt: 1,
  attempted_at: "2026-09-14T10:00:00.500Z",
  status: 200,
  latency_ms: 42,
  outcome: "delivered",
};

describe("shape renames attempted_at to ts", () => {
  // THE ONE ASSERTION THIS FILE EXISTS FOR. A JSONEachRow insert matches keys to column
  // names; the publisher says `attempted_at` and the column is `ts`. If this rename stops
  // happening the rows still insert, the column takes the epoch, the TTL deletes them, and
  // every other check in the chapter passes over an empty table.
  it("emits ts and never attempted_at", () => {
    const row = shape(valid);
    expect(row?.ts).toBe("2026-09-14T10:00:00.500Z");
    expect(row).not.toHaveProperty("attempted_at");
  });

  it("emits exactly the table's ten columns", () => {
    expect(Object.keys(shape(valid) ?? {}).sort()).toEqual([
      "attempt", "delivery_id", "endpoint_id", "environment_id", "error",
      "event_id", "latency_ms", "outcome", "status", "ts",
    ]);
  });
});

describe("absent means NULL, not zero", () => {
  // Zero is a measurement and NULL is an absence. A `status` of 0 asserts that an endpoint
  // answered with status zero; a timeout answered with nothing.
  it("maps an absent status to null rather than 0", () => {
    const { status, ...rest } = valid;
    expect(status).toBe(200);
    expect(shape(rest)?.status).toBeNull();
  });

  it("maps an absent error to null rather than an empty string", () => {
    expect(shape(valid)?.error).toBeNull();
  });

  it("keeps a present error", () => {
    expect(shape({ ...valid, error: "timeout" })?.error).toBe("timeout");
  });

  it("keeps a status of 0 if one genuinely arrives", () => {
    // The absent case and the zero case must stay distinguishable in both directions.
    expect(shape({ ...valid, status: 0 })?.status).toBe(0);
  });
});

describe("null means terminate, not retry", () => {
  // The consumer sets no redelivery limit, so anything this accepts-but-cannot-use would
  // come back until the stream's retention expires.
  it.each([
    ["not an object", 42],
    ["null", null],
    ["a missing environment_id", { ...valid, environment_id: undefined }],
    ["an empty environment_id", { ...valid, environment_id: "" }],
    ["a missing attempted_at", { ...valid, attempted_at: undefined }],
    ["a non-numeric attempt", { ...valid, attempt: "1" }],
    ["a non-finite latency", { ...valid, latency_ms: Number.NaN }],
    ["a missing outcome", { ...valid, outcome: undefined }],
  ])("refuses %s", (_label, input) => {
    expect(shape(input)).toBeNull();
  });
});
