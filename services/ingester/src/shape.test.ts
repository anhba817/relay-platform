import { describe, expect, it } from "vitest";

import { route, shape } from "./shape.js";

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

// ---------------------------------------------------------------------------
// ROUTING (chapter 4.4).
//
// The stream carries a second record type now, and `shape` is the ATTEMPT shaper. Asking it
// about an API request record gets `null`, and `null` means terminate — so before this
// chapter the consumer destroyed every record the next producer would publish. Measured:
// one error line carrying a stream sequence, `m.term()`, and it never comes back, while the
// stream still reports the message present and the consumer reports nothing pending.
//
// `route` is the thing that must be right: it decides WHAT a record is before anything tries
// to turn it into a row. "Not mine" and "malformed" stop being the same answer.
// ---------------------------------------------------------------------------
describe("route tells the record types apart", () => {
  it("does not call an API request record malformed", () => {
    const request = {
      type: "api.request",
      request_id: "55555555-5555-4555-8555-555555555555",
      ts: "2026-09-14T10:00:00.500Z",
      method: "POST",
      status: 201,
      latency_ms: 18,
    };
    expect(route(request).kind).toBe("request");
  });

  // THE LOAD-BEARING CASE. Every record already on the stream was written by a binary that
  // never heard of `type` — 36 of them at this chapter's tag, 0 carrying one. A reader of
  // anything durable cannot require a field its writer did not have, and 043 paid for the
  // opposite: a required `attachments` on the outbox schema terminated every in-flight
  // `message.created` the previous binary had written.
  it("treats an absent type as an attempt, because 3.20's records have none", () => {
    const routed = route(valid);
    expect(routed.kind).toBe("attempt");
    // and it is the same row `shape` produces — the rename included
    expect(routed).toEqual({ kind: "attempt", row: shape(valid) });
  });

  // WIDENING "NOT MINE" MUST NOT SWALLOW THE PARSE ARM. The consumer sets no redelivery
  // limit, so a payload that will never parse has to be terminated or it comes back until
  // the stream's retention expires. Retry forever on transport, terminate at parse.
  it("still calls a malformed attempt malformed, not unclaimed", () => {
    const missingDeliveryId: Record<string, unknown> = { ...valid };
    delete missingDeliveryId["delivery_id"];
    expect(route(missingDeliveryId).kind).toBe("malformed");
    expect(shape(missingDeliveryId)).toBeNull();
  });

  it("calls a record of an unrecognised type unclaimed, and names the type", () => {
    expect(route({ type: "media.scanned", id: "x" })).toEqual({
      kind: "unclaimed",
      type: "media.scanned",
    });
  });

  // A `type` that is not a string is nobody's record either. Leaving it costs the retention
  // window; terminating it costs the record, and those are not comparable.
  it("does not terminate a record whose type is not a string", () => {
    expect(route({ type: 7 }).kind).toBe("unclaimed");
  });

  it("calls a non-object malformed", () => {
    expect(route(null).kind).toBe("malformed");
    expect(route("{}").kind).toBe("malformed");
  });
});
