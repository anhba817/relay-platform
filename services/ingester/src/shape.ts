// What the publisher sends, and what the table takes. They are not the same shape, and the
// difference is one rename that fails silently if it stops happening.
//
// `JSONEachRow` matches JSON keys to COLUMN NAMES. The publisher's field is `attempted_at`;
// the column is `ts`. An unmatched column takes its DEFAULT with no error -- and a
// DateTime64 default is the epoch, which is older than the table's ninety-day TTL, so the
// row is deleted at insert. The insert returns OK, the consumer acknowledges, the stream
// drains to zero, and the table stays empty while every instrument reports success.
//
// So the ingester SHAPES AND RENAMES rather than forwarding what it was given. Two server
// settings and one table constraint stand behind this function, each catching a different
// way of getting it wrong -- but the function is the thing that has to be right.

/** The publisher's record, as it arrives on `analytics.webhook.attempt.{env}`. */
export interface AttemptEvent {
  delivery_id: string;
  endpoint_id: string;
  environment_id: string;
  event_id: string;
  attempt: number;
  attempted_at: string;
  /** Absent when nothing answered. A timeout has no status. */
  status?: number;
  /** Present when there was no status. */
  error?: string;
  latency_ms: number;
  outcome: string;
}

/** One row of `relay_analytics.webhook_attempts`, keyed by column name. */
export interface AttemptRow {
  environment_id: string;
  ts: string;
  delivery_id: string;
  endpoint_id: string;
  event_id: string;
  attempt: number;
  status: number | null;
  error: string | null;
  latency_ms: number;
  outcome: string;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Shape one record, or return null if it will never be valid.
 *
 * NULL MEANS TERMINATE, NOT RETRY. The consumer sets no redelivery limit, so a payload that
 * cannot be parsed would otherwise come back until the stream's retention expires. The same
 * bytes fail the same way every time; the api's own consumer runtime draws this line in the
 * same words.
 *
 * An absent `status` or `error` becomes NULL rather than 0 or "". Zero is a measurement and
 * NULL is an absence: a `status` of 0 asserts that an endpoint answered with status zero. */
export function shape(raw: unknown): AttemptRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Partial<AttemptEvent>;

  if (
    !isString(e.environment_id) ||
    !isString(e.attempted_at) ||
    !isString(e.delivery_id) ||
    !isString(e.endpoint_id) ||
    !isString(e.event_id) ||
    !isNumber(e.attempt) ||
    !isNumber(e.latency_ms) ||
    !isString(e.outcome)
  ) {
    return null;
  }

  return {
    environment_id: e.environment_id,
    // THE RENAME. Everything else is a copy; this is the line the table cannot survive
    // being wrong, because being wrong about it looks exactly like success.
    ts: e.attempted_at,
    delivery_id: e.delivery_id,
    endpoint_id: e.endpoint_id,
    event_id: e.event_id,
    attempt: e.attempt,
    status: isNumber(e.status) ? e.status : null,
    error: isString(e.error) ? e.error : null,
    latency_ms: e.latency_ms,
    outcome: e.outcome,
  };
}

/** The api's record, as it arrives on `analytics.api.request.{env|_none}`. */
export interface RequestEvent {
  type: string;
  request_id: string;
  ts: string;
  method: string;
  status: number;
  latency_ms: number;
  principal_kind: string;
  refused_at: string;
  /** Absent when the router did not run -- a 404 matched nothing, and a middleware refusal
   *  ended the response before routing. Two different facts, separated by `refused_at`. */
  endpoint?: string;
  /** Absent when the request resolved to no tenant. Never null and never a sentinel. */
  environment_id?: string;
  /** Absent unless the rate limiter refused. */
  limited_operation?: string;
}

/** One row of `relay_analytics.api_requests`, keyed by column name. */
export interface RequestRow {
  environment_id: string | null;
  ts: string;
  request_id: string;
  endpoint: string | null;
  method: string;
  status: number;
  latency_ms: number;
  principal_kind: string;
  refused_at: string;
  limited_operation: string | null;
}

/** Shape one API request record, or return null if it will never be valid.
 *
 * `type` IS READ AND THEN DROPPED. The wire record has eleven fields and the table has ten:
 * `type` is the router's discriminator and has no column. Forwarding it lands
 * `Code: 117. Unknown field found while parsing JSONEachRow format: type` -- loud, because
 * `input_format_skip_unknown_fields=0` is set, and the one place in this design where a
 * spread fails loudly rather than open. The row is still built by naming every field:
 * relying on a server setting to catch a shaping mistake is relying on it to be configured.
 *
 * ABSENT IS NULL, NOT "". The columns are `LowCardinality(Nullable(String))` because
 * `LowCardinality(String)` cannot hold the difference -- measured, an absent field and an
 * explicit empty string both land as ''. A 404 has no endpoint; a route named "" does not
 * exist. */
export function shapeRequest(raw: unknown): RequestRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Partial<RequestEvent>;

  if (
    !isString(e.request_id) ||
    !isString(e.ts) ||
    !isString(e.method) ||
    !isNumber(e.status) ||
    !isNumber(e.latency_ms) ||
    !isString(e.principal_kind) ||
    !isString(e.refused_at)
  ) {
    return null;
  }

  return {
    environment_id: isString(e.environment_id) ? e.environment_id : null,
    ts: e.ts,
    request_id: e.request_id,
    endpoint: isString(e.endpoint) ? e.endpoint : null,
    method: e.method,
    status: e.status,
    latency_ms: e.latency_ms,
    principal_kind: e.principal_kind,
    refused_at: e.refused_at,
    limited_operation: isString(e.limited_operation) ? e.limited_operation : null,
  };
}

// ---------------------------------------------------------------------------
// ROUTING (chapter 4.4). The stream carries more than one record type now.
//
// `shape` above is the ATTEMPT shaper, and it answers `null` for anything else — which the
// consumer reads as "terminate". So until this chapter, publishing a second record type onto
// `ANALYTICS` destroyed it: one error line carrying a stream sequence, `m.term()`, and it
// never comes back. Measured at 049 phase 1, with an attempt record beside it as the control:
//
//     pass 1: written 1  malformed 1
//     pass 2: written 0  malformed 0
//     stream still holds 2 of 2 · consumer num_pending 0 · ack_pending 0
//
// BOTH INSTRUMENTS REPORT NOTHING WRONG. The stream says the record is there, because
// `retention: Limits` keeps a terminated message; the consumer says there is nothing pending.
// The only trace is the error line, and it carries a sequence and no type.
//
// So the decision "what is this record" is made BEFORE anything tries to turn it into a row,
// and "not mine" stops being the same answer as "malformed". One is a record this consumer
// does not write and must leave alone; the other will never parse and must not come back.
// ---------------------------------------------------------------------------

/** The wire's own discriminator. R11: the PAYLOAD says what the payload is, not the subject —
 *  a router that parses subjects has to be right about tokens too, and a malformed token
 *  publishes a subject one level deeper that no intended filter matches. */
export const API_REQUEST_TYPE = "api.request";
export const CONNECTION_OPENED_TYPE = "connection.opened";
export const CONNECTION_CLOSED_TYPE = "connection.closed";

/** The gateway's record, as it arrives on `analytics.connection.{opened|closed}.{env}`. */
export interface ConnectionEvent {
  type: string;
  connection_id: string;
  environment_id: string;
  user_external_id: string;
  ts: string;
  /** Close only. */
  close_code?: number;
  /** Close only. */
  duration_ms?: number;
}

/** One row of `relay_analytics.connection_events`, keyed by column name. */
export interface ConnectionRow {
  environment_id: string;
  ts: string;
  connection_id: string;
  event: string;
  close_code: number | null;
  duration_ms: number | null;
  user_external_id: string;
}

/** Shape one connection record, or return null if it will never be valid.
 *
 * `type` IS READ, RENAMED AND DROPPED -- all three, which is one more than the request
 * shaper does. The wire carries `type: "connection.opened"` because that is what `route()`
 * discriminates on; the column is `event` and holds `opened`. So this function both drops a
 * field the table has no column for and derives the column from it, and getting the derivation
 * backwards is the failure that looks like success: `event` would hold the whole dotted string,
 * `LowCardinality` would accept it without complaint, and every query filtering
 * `event = 'opened'` would return nothing for ever.
 *
 * `environment_id` IS REQUIRED HERE, unlike the request shaper's. A connection event only
 * exists after a handshake, so a record arriving without one is malformed rather than
 * tenantless -- there is no `_none` arm on this grammar to fall back to.
 *
 * ABSENT IS NULL, NOT ZERO. A `close_code` of 0 is a claim that a socket closed with code
 * zero, and a `duration_ms` of 0 that it lasted no time. An open record carries neither. */
export function shapeConnection(raw: unknown): ConnectionRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Partial<ConnectionEvent>;

  if (
    !isString(e.environment_id) ||
    !isString(e.ts) ||
    !isString(e.connection_id) ||
    !isString(e.user_external_id) ||
    !isString(e.type)
  ) {
    return null;
  }

  // THE RENAME, AND IT IS A CLOSED SET RATHER THAN A SUFFIX. `e.type.split(".")[1]` would
  // turn any `connection.*` record into a row with whatever word followed the dot, which is
  // a shaper that cannot be wrong about a record it has never seen -- the wrong kind of
  // robust. Two types, two events, and anything else is somebody else's record.
  const event =
    e.type === CONNECTION_OPENED_TYPE
      ? "opened"
      : e.type === CONNECTION_CLOSED_TYPE
        ? "closed"
        : null;
  if (event === null) return null;

  return {
    environment_id: e.environment_id,
    ts: e.ts,
    connection_id: e.connection_id,
    event,
    close_code: isNumber(e.close_code) ? e.close_code : null,
    duration_ms: isNumber(e.duration_ms) ? e.duration_ms : null,
    user_external_id: e.user_external_id,
  };
}

export type Shaped =
  | { kind: "attempt"; row: AttemptRow }
  | { kind: "request"; row: RequestRow }
  | { kind: "connection"; row: ConnectionRow }
  | { kind: "malformed" }
  | { kind: "unclaimed"; type: string };

/** Decide what a record is.
 *
 * AN ABSENT `type` MEANS ATTEMPT, AND THAT IS A COMPATIBILITY RULE RATHER THAN A DEFAULT.
 * Chapter 3.20's publisher has no `type` field and never will for the records already on the
 * stream — 36 of them at this chapter's tag, 0 carrying one. A reader of anything durable
 * cannot require a field its writer did not have; 043 paid for that lesson when a required
 * `attachments` terminated every in-flight `message.created` written by the previous binary.
 *
 * A RECOGNISED TYPE WITH MISSING FIELDS IS STILL MALFORMED. Widening "not mine" must not
 * swallow the parse arm: 048's rule is retry forever on transport, terminate at parse, and
 * the poison case is what makes the unbounded redelivery safe. */
export function route(raw: unknown): Shaped {
  if (typeof raw !== "object" || raw === null) return { kind: "malformed" };

  const type = (raw as { type?: unknown }).type;
  if (type === undefined) {
    const row = shape(raw);
    return row === null ? { kind: "malformed" } : { kind: "attempt", row };
  }
  if (type === API_REQUEST_TYPE) {
    const row = shapeRequest(raw);
    return row === null ? { kind: "malformed" } : { kind: "request", row };
  }
  // The third arm (chapter 4.5). TWO TYPES, ONE ARM, because they are one table: the
  // subject separates an open from a close for a consumer that wants only one, and this
  // consumer wants both.
  if (type === CONNECTION_OPENED_TYPE || type === CONNECTION_CLOSED_TYPE) {
    const row = shapeConnection(raw);
    return row === null ? { kind: "malformed" } : { kind: "connection", row };
  }

  // Anything else is somebody's record and not this consumer's. Leaving it costs the stream's
  // retention window; terminating it costs the record. Those are not comparable, and a
  // consumer that does not recognise a type is the party with the least information.
  return { kind: "unclaimed", type: typeof type === "string" ? type : String(type) };
}
