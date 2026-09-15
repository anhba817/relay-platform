// FR-ANL-01's last arm: an analytical event when a connection opens and when it closes.
//
// THE FIRE-AND-FORGET ARGUMENT IS 3.20's AND THE SUBJECT GRAMMAR IS 4.3's. Neither is
// re-derived here. What is new is that this producer BUFFERS, and the three paragraphs
// below are the consequences of that one decision.
import {
  connectionClosedSubject,
  connectionOpenedSubject,
} from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import type { Connection } from "../registry.js";

/** Five seconds, and the number is a budget rather than a preference.
 *
 * FR-ANL-04 allows 60 seconds from the originating operation to the event being
 * queryable, "under normal conditions" -- and the ingester's own batch bound spends up
 * to 2 of them (`docs/05-sad.md` §4; DR-11 itself names no interval and no row count).
 *
 * COPYING `METER_INTERVAL_MS` WOULD BREACH IT. The meter ticks every 60,000 ms and the
 * whole posture of this module is *be like the meter*, so the obvious number is the
 * wrong one: the meter feeds a monthly quota with no latency clause over it, and this
 * feeds a store that has one.
 *
 * And the two pressures are less opposed than they look. The tick's win is removing the
 * serial round trip from whatever accumulated, not waiting longer -- at 0.0034 ms a
 * record the publish is effectively free at any interval, and the 2.3-second burst a
 * deploy would cost is a property of publishing PER CLOSE, not of a short tick. So a
 * short interval costs almost nothing and buys the whole budget. */
export const FLUSH_INTERVAL_MS = 5_000;

/** How many unpublished records to hold before dropping.
 *
 * `meter.ts` faced this and its cap is `MAX_RETAINED_CLOSED = 4_000`, bounded by closes
 * since the last ACCEPTED report. THIS BOUND MEANS THE SAME THING, and only because of
 * the retention rule below: a buffer that emptied on every flush regardless of outcome
 * could never reach a cap at all, because an unreachable broker would drain it every
 * five seconds into failures.
 *
 * AND IT IS TWO RECORDS PER CONNECTION, NOT ONE. The meter retains a closed entry per
 * (connection, period); this retains an open AND a close. At NFR-SCL-01's 10,000
 * sockets a full mass disconnect with the broker away overflows this, which is the
 * case the drop counter exists to make visible rather than the case it prevents. */
export const MAX_BUFFERED = 4_000;

/** The wire shape. Snake case because it leaves the platform. */
export interface ConnectionEvent {
  type: "connection.opened" | "connection.closed";
  connection_id: string;
  environment_id: string;
  user_external_id: string;
  ts: string;
  close_code?: number;
  duration_ms?: number;
}

/** Which event, and what only a close carries.
 *
 * A DISCRIMINATED UNION RATHER THAN TWO OPTIONAL ARGUMENTS. An open has no close code
 * and no duration, and this makes supplying one a type error rather than a field the
 * shaper has to remember to omit -- a design in which a case cannot arise beats a
 * branch that handles it. */
export type ConnectionEventKind =
  | { kind: "opened" }
  | { kind: "closed"; at: Date; code: number };

/** IDENTIFIERS, INSTANTS AND A CODE ONLY.
 *
 * Built by NAMING every field rather than by spreading the connection, and that is the
 * point: `Connection` carries `identity.token` -- the bearer token the client presented
 * at connect -- plus `buffer` (frames), `channelIds` and the socket itself. A spread
 * would put any of them on a stream with seven-day retention. An allow-list fails
 * closed when somebody adds a field; a spread fails open.
 *
 * The authority is constitution III's allow-list: the analytical store holds "only
 * lengths, identifiers, and metadata", and a credential is none of the three. FR-ANL-11
 * governs message text and NFR-SEC-06 governs application LOGS; neither reaches a
 * record on a stream, which is why the rule is stated as an allow-list here.
 *
 * ABSENT, NOT EMPTY. `exactOptionalPropertyTypes` is on, so the close-only fields are
 * spread in rather than assigned -- an explicit `undefined` is not an absent key, and
 * 4.4 measured that a `LowCardinality(String)` column cannot tell the two apart. */
export function toConnectionEvent(
  connection: Connection,
  event: ConnectionEventKind,
): ConnectionEvent {
  const base = {
    connection_id: connection.id,
    environment_id: connection.environmentId,
    user_external_id: connection.identity.userExternalId,
  };
  if (event.kind === "opened") {
    return {
      type: "connection.opened",
      ...base,
      // FR-005a. THE CONNECTION'S OWN INSTANT, NOT THIS MOMENT. `openedAt` is stamped
      // before the resume and before the ack "because the socket is already open and
      // already costing a minute", and it is the field the meter reads. Two instants
      // for one open would make the reconciliation disagree for a reason that is
      // neither of the two the chapter explains.
      ts: connection.openedAt.toISOString(),
    };
  }
  return {
    type: "connection.closed",
    ...base,
    ts: event.at.toISOString(),
    close_code: event.code,
    // Close minus open, in milliseconds. The interval's two endpoints are stated rather
    // than implied: `openedAt` is the handshake, `at` is the socket's close.
    //
    // NOT THE METER'S QUANTITY. The meter charges every calendar minute a connection
    // was open for any part of, so 00:00:59 to 00:01:01 is TWO connection-minutes and
    // 2,000 ms. Different quantities sharing a name; the reconciliation compares
    // buckets against buckets.
    duration_ms: Math.max(0, event.at.getTime() - connection.openedAt.getTime()),
  };
}

/** One record, addressed and keyed. The same three fields the api's outbox port uses,
 *  for the same reason: which broker is a configuration detail. */
export interface PublishableRecord {
  subject: string;
  /** `{connection_id}:{event}`, NOT the connection id alone. One connection produces
   *  two records, and 3.20 learned exactly this with `{delivery}:{attempt}`: a delivery
   *  id alone collapsed seven retries into one message. */
  id: string;
  payload: ConnectionEvent;
}

export function recordFor(event: ConnectionEvent): PublishableRecord {
  const subject =
    event.type === "connection.opened"
      ? connectionOpenedSubject(event.environment_id)
      : connectionClosedSubject(event.environment_id);
  return {
    subject,
    id: `${event.connection_id}:${event.type === "connection.opened" ? "opened" : "closed"}`,
    payload: event,
  };
}

/** What the buffer needs of a publisher: ONE MESSAGE PER RECORD.
 *
 * Not 500 records in one message. One message carries one subject and the subject
 * carries the tenant; one message carries one `Nats-Msg-Id` and the deduplication id is
 * per record; and the ingester's `route()` takes one record per message -- handed an
 * array it finds no `type`, shapes to null, and TERMINATES it. */
export interface ConnectionPublisher {
  publish(record: PublishableRecord): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectionLog {
  /** Beside `registry.add`. */
  opened(connection: Connection): void;
  /** Beside `meter.closed`. Must not throw and must not be awaited. */
  closed(connection: Connection, at: Date, code: number): void;
  /** Exposed for the timer, for the shutdown flush, and for tests that drive their own
   *  clock -- the same three reasons `meter.reportOnce` is. */
  flushOnce(): Promise<void>;
  /** How many records are waiting for an accepted publish. */
  buffered(): number;
  /** How many were discarded at the cap. Counted rather than silent. */
  dropped(): number;
  stop(): void;
  /** Stop the tick, send what is left, and close the client -- in that order.
   *
   * ONE FABRIC WITH ONE CLOSE, because `main.test.ts` reads `main.ts`'s source and
   * asserts that every module it builds is both passed into `attachSessions` and
   * awaited in `shutdown()`. A publisher held as a second const would satisfy neither
   * half, and the honest fix is for this module to own its publisher's lifetime rather
   * than for the guard to gain an exemption. The flush is the work `sessions.close()`
   * is ordered first to make possible. */
  close(): Promise<void>;
}

export interface ConnectionLogOptions {
  publisher: ConnectionPublisher;
  logger: Logger;
  intervalMs?: number;
  maxBuffered?: number;
}

export function createConnectionLog({
  publisher,
  logger,
  intervalMs = FLUSH_INTERVAL_MS,
  maxBuffered = MAX_BUFFERED,
}: ConnectionLogOptions): ConnectionLog {
  let pending: PublishableRecord[] = [];
  let discarded = 0;

  /** A RECORD WHOSE PUBLISH FAILED GOES BACK, AND THAT IS THE METER'S RULE FOR ITS ONE
   *  EXCEPTION APPLIED TO ALL OF THIS.
   *
   *  `meter.ts`: "a report that cannot be delivered is DROPPED rather than queued ...
   *  WITH ONE EXCEPTION ... a connection that has CLOSED has no next report to repair a
   *  lost one, so its final total is retained until a report carrying it is accepted."
   *
   *  Every connection event is in that exception. An open is sent once and a close is
   *  sent once; there is no later record carrying the same fact again. So the meter's
   *  special case is this producer's general rule. */
  function enqueue(record: PublishableRecord): void {
    if (pending.length >= maxBuffered) {
      // OLDEST FIRST, and the argument does NOT transfer from the meter unchanged. The
      // meter drops the oldest because under-counting is "the same direction as every
      // other loss in this design" -- it is a bill, and billing for a socket nobody
      // holds is the worse error. A connection log is not a bill: both directions lose
      // a fact and neither is safe.
      //
      // Oldest anyway, for a different reason. Dropping the NEWEST discards the records
      // describing the outage itself -- the opens and closes happening while the broker
      // is away -- which is the window an operator opens this log to see. The oldest
      // records are the ones most likely to have a neighbour that survived.
      pending.shift();
      discarded += 1;
      logger.log("error", "connection_log.buffer_overflow", {
        discarded,
        buffered: pending.length,
      });
    }
    pending.push(record);
  }

  function opened(connection: Connection): void {
    enqueue(recordFor(toConnectionEvent(connection, { kind: "opened" })));
  }

  function closed(connection: Connection, at: Date, code: number): void {
    enqueue(recordFor(toConnectionEvent(connection, { kind: "closed", at, code })));
  }

  async function flushOnce(): Promise<void> {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];

    // PIPELINED, ONE MESSAGE PER RECORD. Every publish goes out without awaiting the
    // one before it and the acks are collected together: 0.229 ms each when awaited
    // serially against 0.0034 ms pipelined, which is 2.3 seconds for a deploy that
    // closes 10,000 sockets against 34 ms.
    const outcomes = await Promise.allSettled(
      batch.map((record) => publisher.publish(record)),
    );

    // PER RECORD, because one message per record means this flush has as many answers
    // as it had records. The meter never faces this: it sends one report and gets one
    // answer. A flush that treated a partial failure as total loss would discard
    // records the broker accepted; as total success, records it did not.
    // THE REJECTIONS THEMSELVES, NOT A PARALLEL LIST OF INDICES. An earlier version kept
    // `failed` (the records) and looked the first reason up separately with
    // `outcomes.find(...)`, which needed a `?? "unknown"` fallback for a case that cannot
    // occur: inside `failed.length > 0` there is always a rejection. Coverage reported the
    // file at 93.75% branches with that one arm uncovered, and the arm was not missing a
    // test -- it was unreachable. **A design in which a case cannot arise beats a branch
    // that handles it, because the branch is the thing that rots.** Pairing each record
    // with its own outcome deletes the branch instead of testing it.
    const rejected: Array<{ record: PublishableRecord; reason: unknown }> = [];
    outcomes.forEach((outcome, i) => {
      const record = batch[i];
      if (outcome.status === "rejected" && record !== undefined) {
        rejected.push({ record, reason: outcome.reason });
      }
    });
    for (const { record } of rejected) enqueue(record);

    if (rejected[0] !== undefined) {
      // ONE LINE PER FLUSH, not per record, and it carries counts rather than payloads
      // -- the shape `meter.report_failed` uses. No subject, no id, no record.
      logger.log("error", "connection_log.publish_failed", {
        attempted: batch.length,
        failed: rejected.length,
        buffered: pending.length,
        error: String(rejected[0].reason),
      });
    }
  }

  // STOPPED, NOT unref'd -- the meter's pattern (`meter.ts:218`), cleared by `stop()`
  // from shutdown. An unref'd timer lets the process exit with records still buffered.
  const timer = setInterval(() => {
    void flushOnce();
  }, intervalMs);

  return {
    opened,
    closed,
    flushOnce,
    buffered: () => pending.length,
    dropped: () => discarded,
    stop: () => clearInterval(timer),
    async close(): Promise<void> {
      clearInterval(timer);
      // The last flush before the client goes. A record still buffered here is one a
      // killed process would have lost, which is the difference between a clean stop
      // and a kill that the chapter publishes as a number.
      await flushOnce();
      await publisher.close();
    },
  };
}
