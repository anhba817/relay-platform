// FR-ANL-07's producer: one analytical record per API request.
//
// THE FIRE-AND-FORGET ARGUMENT IS CHAPTER 3.20's AND IS NOT RE-DERIVED HERE. That chapter
// weighed "record every attempt" against constitution III's independence and chose
// independence, because a lost attempt record is a gap in a dashboard and a blocked
// operational transaction is a customer's webhooks stopping. The same trade applies here and
// is STRONGER, because the party who waits is a customer rather than a background job. So
// "every request" is approximate, and the chapter says so in the paragraph that introduces
// the feature rather than in a footnote.
import {
  apiRequestSubject,
  apiRequestSubjectWithoutTenant,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import type { Publisher } from "../outbox/publisher";

/** Where the response was decided.
 *
 * TWO OF THESE ARE STAMPED AND TWO ARE INFERRED, because a guard refusal and a handler
 * response are IDENTICAL from the producer's vantage point -- same status, same `req.route`,
 * same request properties. Measured:
 *
 *   /v1/fine         status=200 route=set  own keys=["body","route"]
 *   /v1/guard401     status=401 route=set  own keys=["body","route"]
 *   /v1/handler401   status=401 route=set  own keys=["body","route"]
 *
 * So `middleware` and `guard` are stamped by the layer that refuses; `unmatched` and
 * `handler` are inferred from the absence of a stamp plus whether the router ran.
 *
 * THE `handler` ARM IS AN INFERENCE FROM SILENCE. A layer that refuses without stamping is
 * recorded as `handler` -- a plausible value, wrong, in a column nothing would flag. That is
 * the fence-chain checker's shape, where the answer meaning "clean" and the answer meaning
 * "never looked" printed the same line. Any new guard MUST stamp; `credential.guard.ts` is
 * the only one today and `request-log.middleware.test.ts` fails if it stops. */
export type RefusedAt = "handler" | "guard" | "middleware" | "unmatched";

/** Set by whichever layer ended the response before the handler ran. */
export const REFUSED_AT = Symbol.for("relay:refused-at");
/** Set by the rate limiter: the operation class it actually refused on. */
export const LIMITED_OPERATION = Symbol.for("relay:limited-operation");

export interface RequestFacts {
  requestId: string;
  at: Date;
  method: string;
  status: number;
  latencyMs: number;
  /** Absent when the router did not run. A 404 matched nothing; a middleware refusal ended
   *  the response before routing. Two different facts, and `refusedAt` separates them. */
  endpoint?: string;
  /** Absent when the request resolved to no tenant. */
  environmentId?: string;
  principalKind: "application" | "user" | "platform" | "none";
  refusedAt: RefusedAt;
  /** `send` | `rest` | `signup`, only when the rate limiter refused. */
  limitedOperation?: string;
}

/** The wire shape. Snake case because it leaves the platform. */
interface RequestEvent {
  type: "api.request";
  request_id: string;
  ts: string;
  method: string;
  status: number;
  latency_ms: number;
  principal_kind: string;
  refused_at: string;
  endpoint?: string;
  environment_id?: string;
  limited_operation?: string;
}

/** IDENTIFIERS, STATUSES AND DURATIONS ONLY (FR-006, NFR-SEC-06).
 *
 * Built by NAMING every field rather than by spreading the input, and that is the point: a
 * spread would carry whatever a future caller happened to attach to the request -- a body, a
 * header, a decrypted credential -- onto a stream with seven-day retention. An allow-list
 * fails closed when somebody adds a field; a spread fails open. 3.20's own shaper makes the
 * same argument in the same words.
 *
 * FR-ANL-07's "truncated payload" is NOT here, and is amended out of the SRS rather than
 * implemented narrowly: `POST /v1/channels/{id}/messages` has a body that IS message text,
 * truncation keeps the part a person wrote, and FR-ANL-11 and constitution VI both forbid it.
 *
 * ABSENT, NOT EMPTY. `exactOptionalPropertyTypes` is on, so the optional fields are spread in
 * rather than assigned -- an explicit `undefined` is not an absent key, and the column is
 * `LowCardinality(Nullable(String))` precisely because '' and absent are different claims. */
export function toRequestEvent(facts: RequestFacts): RequestEvent {
  return {
    type: "api.request",
    request_id: facts.requestId,
    ts: facts.at.toISOString(),
    method: facts.method,
    status: facts.status,
    latency_ms: facts.latencyMs,
    principal_kind: facts.principalKind,
    refused_at: facts.refusedAt,
    ...(facts.endpoint !== undefined ? { endpoint: facts.endpoint } : {}),
    ...(facts.environmentId !== undefined ? { environment_id: facts.environmentId } : {}),
    ...(facts.limitedOperation !== undefined
      ? { limited_operation: facts.limitedOperation }
      : {}),
  };
}

/** Publish one request record. Never throws.
 *
 * NOT AWAITED ON THE REQUEST PATH. The caller starts this and returns; the response has
 * already been sent by the time it runs at all. The failure is swallowed HERE rather than at
 * the call site, so no caller can turn an analytics outage into an API outage by forgetting
 * a `catch`.
 *
 * THE DEDUPLICATION ID IS THE REQUEST ID. 3.20 uses `{delivery}:{attempt}` because the
 * delivery id alone collapsed seven retries into one message; a request id has no second
 * dimension. And it is not caller-controlled: `RequestContextMiddleware` mints a fresh v4 per
 * request and nothing in this platform reads an inbound `X-Request-Id`, measured -- the same
 * header sent twice came back as two different ids. */
export async function publishRequest(
  publisher: Publisher,
  logger: Logger,
  facts: RequestFacts,
): Promise<void> {
  try {
    await publisher.publish({
      subject:
        facts.environmentId === undefined
          ? apiRequestSubjectWithoutTenant()
          : apiRequestSubject(facts.environmentId),
      id: facts.requestId,
      payload: toRequestEvent(facts),
    });
  } catch (error) {
    // One line, no payload, no secret, no rethrow. The response is already sent; there is
    // nothing this failure can usefully undo and plenty it could break by trying.
    logger.log("error", "request_log.publish_failed", {
      request_id: facts.requestId,
      error: String(error),
    });
  }
}
