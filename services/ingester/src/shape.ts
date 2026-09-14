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
