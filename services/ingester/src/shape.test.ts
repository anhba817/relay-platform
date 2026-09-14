import { describe, expect, it } from "vitest";

import { route, shape, shapeRequest } from "./shape.js";

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

const validRequest = {
  type: "api.request",
  request_id: "55555555-5555-4555-8555-555555555555",
  ts: "2026-09-14T10:00:00.500Z",
  method: "POST",
  status: 201,
  latency_ms: 18,
  principal_kind: "application",
  refused_at: "handler",
  endpoint: "/v1/channels/:channelId/messages",
  environment_id: "11111111-1111-4111-8111-111111111111",
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
    expect(route(validRequest).kind).toBe("request");
  });

  it("calls a request record with missing fields malformed, not unclaimed", () => {
    const incomplete: Record<string, unknown> = { ...validRequest };
    delete incomplete["refused_at"];
    expect(route(incomplete).kind).toBe("malformed");
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

describe("shapeRequest drops `type` and says absent rather than empty", () => {
  // THE WIRE HAS ELEVEN FIELDS AND THE TABLE HAS TEN. `type` is the router's discriminator
  // and has no column; forwarded, it lands `Code: 117. Unknown field found while parsing
  // JSONEachRow format: type`. Loud, because skip-unknown-fields is off -- and the row is
  // still built by naming every field, because relying on a server setting to catch a
  // shaping mistake is relying on it to be configured.
  it("emits exactly the table's ten columns, and `type` is not one of them", () => {
    const row = shapeRequest(validRequest);
    expect(row).not.toBeNull();
    expect(Object.keys(row!).sort()).toEqual([
      "endpoint",
      "environment_id",
      "latency_ms",
      "limited_operation",
      "method",
      "principal_kind",
      "refused_at",
      "request_id",
      "status",
      "ts",
    ]);
    expect(row).not.toHaveProperty("type");
  });

  // A 404 matched nothing and a middleware refusal ended the response before the router ran.
  // Neither is a route named the empty string, and `LowCardinality(String)` cannot hold the
  // difference -- an absent field and an explicit "" both land as ''.
  it("maps an absent endpoint to null rather than an empty string", () => {
    const noRoute: Record<string, unknown> = { ...validRequest };
    delete noRoute["endpoint"];
    expect(shapeRequest(noRoute)?.endpoint).toBeNull();
  });

  it("maps an absent environment to null, never a sentinel", () => {
    const tenantless: Record<string, unknown> = { ...validRequest };
    delete tenantless["environment_id"];
    const row = shapeRequest(tenantless);
    expect(row?.environment_id).toBeNull();
    expect(row?.environment_id).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("maps an absent limited_operation to null", () => {
    expect(shapeRequest(validRequest)?.limited_operation).toBeNull();
  });

  it("keeps a status of 0 if one genuinely arrives", () => {
    expect(shapeRequest({ ...validRequest, status: 0 })?.status).toBe(0);
  });

  it("refuses a non-object", () => {
    expect(shapeRequest(null)).toBeNull();
  });
});

// T029a. THE BATCHED-PAYLOAD FORM, FALSIFIED AGAINST THE ROUTER RATHER THAN ARGUED.
//
// `research.md` R3's third measurement read "batched 500 per publish", which three
// artifacts adopted as 500 RECORDS IN ONE MESSAGE. This is what that costs, and it
// needs no broker to show: an array is an object, it has no `type`, so it takes the
// attempt arm, `shape()` returns null, and `ingest.ts` calls `m.term()`. Five hundred
// records destroyed and counted as ONE malformed.
describe("an array of records is malformed, not a batch", () => {
  // COMPLETE RECORDS, and the first draft of this fixture was not. It carried `type`,
  // `connection_id` and `environment_id` only, so the single-record control came back
  // `malformed` -- correctly, because a record missing `ts` and `user_external_id` IS
  // malformed. A thin fixture would have made the batch assertion below pass for the wrong
  // reason: an array is not malformed because it is short of fields.
  const RECORDS = [
    {
      type: "connection.opened",
      connection_id: "a",
      environment_id: "e",
      user_external_id: "u1",
      ts: "2026-09-14T12:00:00.000Z",
    },
    {
      type: "connection.closed",
      connection_id: "a",
      environment_id: "e",
      user_external_id: "u1",
      ts: "2026-09-14T12:00:05.000Z",
      close_code: 1000,
      duration_ms: 5000,
    },
  ];

  it("routes to malformed, which TERMINATES -- it does not reach `unclaimed`", () => {
    expect(route(RECORDS).kind).toBe("malformed");
  });

  it("and a single record of that type is CLAIMED, now that phase 3 has landed", () => {
    // THIS ASSERTION READ `unclaimed` FOR ONE PHASE, AND THE CHANGE IS THE POINT.
    // Phase 2 published connection records into a stream whose consumer did not know the
    // type, and `route()` answered `unclaimed` -- neither acked nor terminated, redelivered
    // until something claimed it. This phase is that something. The window is closed and the
    // count it produced is in `baseline.txt`, because it cannot be taken again.
    const routed = route(RECORDS[0]);
    expect(routed.kind).toBe("connection");
    if (routed.kind === "connection") expect(routed.row.event).toBe("opened");
  });

  it("still leaves a type nobody claims, which is the arm the batch never reaches", () => {
    // The control the assertion above used to be. `unclaimed` must survive this chapter:
    // it is what makes the NEXT producer's window safe, and a batch reaches `malformed`
    // instead -- terminated, 500 records at a time, counted as one.
    const routed = route({ type: "media.scanned", media_id: "m1" });
    expect(routed.kind).toBe("unclaimed");
    if (routed.kind === "unclaimed") expect(routed.type).toBe("media.scanned");
  });

  it("renames `type` to `event` rather than carrying the dotted string into the column", () => {
    // The failure that looks like success: `event` holding "connection.opened" is accepted
    // by LowCardinality without complaint, and every query filtering `event = 'opened'`
    // returns nothing for ever.
    const routed = route({
      type: "connection.closed",
      connection_id: "c1",
      environment_id: "e1",
      user_external_id: "u1",
      ts: "2026-09-14T12:00:00.000Z",
      close_code: 1000,
      duration_ms: 5000,
    });
    expect(routed.kind).toBe("connection");
    if (routed.kind === "connection") {
      expect(routed.row.event).toBe("closed");
      expect(routed.row).not.toHaveProperty("type");
      expect(routed.row.close_code).toBe(1000);
    }
  });

  it("maps an absent close_code and duration_ms to NULL, not to zero", () => {
    // A close_code of 0 is a claim that a socket closed with code zero.
    const routed = route({
      type: "connection.opened",
      connection_id: "c1",
      environment_id: "e1",
      user_external_id: "u1",
      ts: "2026-09-14T12:00:00.000Z",
    });
    expect(routed.kind).toBe("connection");
    if (routed.kind === "connection") {
      expect(routed.row.close_code).toBeNull();
      expect(routed.row.duration_ms).toBeNull();
    }
  });

  it("refuses a connection record with no environment, rather than inventing a tenantless arm", () => {
    // There is no `_none` grammar here: a connection event only exists after a handshake,
    // so a record without a tenant is malformed rather than tenantless.
    const routed = route({
      type: "connection.opened",
      connection_id: "c1",
      user_external_id: "u1",
      ts: "2026-09-14T12:00:00.000Z",
    });
    expect(routed.kind).toBe("malformed");
  });
});
