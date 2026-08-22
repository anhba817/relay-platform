import type { InternalUsageReportEntry } from "@relay/protocol";
import type { Logger } from "@relay/service-kit";

import type { ApiClient } from "./api-client.js";
import type { Connection, Registry } from "./registry.js";

// Connection-minutes, from the service that cannot write them (chapter 3.11).
//
// The api can count messages and distinct users because both are already rows.
// It cannot count a connection: nothing records one, and the only process that
// can see one is this one — which owns no tables (ADR-05, and `registry.ts`
// states the property: "no pg, no drizzle-orm, no repository import"). So the
// gateway observes and the api records, and everything interesting lives in the
// protocol between them.
//
// This file has two halves and they are separated on purpose. Below is the pure
// one — arithmetic over instants, no timer, no transport, no api client — which
// is the half every timing assertion in this chapter drives on a clock it
// supplies. The timer and the report live under it.

/** The usage period an instant belongs to. DUPLICATED FROM THE API, deliberately.
 *
 * `limits.ts` next door already duplicates the api's window arithmetic and says
 * why: "a package for two small functions would be an abstraction constitution
 * VII asks to be justified, and this one could not be." The same argument holds
 * here and the stakes are higher — a rate-limit window that disagrees between two
 * services costs one window of over-service, while a PERIOD that disagrees puts a
 * tenant's minutes in a month nobody reads. So the copy is pinned by a drift test
 * in both packages rather than by good intentions (research R18). */
export function periodOf(at: Date): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/** The minute an instant belongs to — the unit itself, floored, in UTC. */
export function minuteOf(at: Date): string {
  const y = at.getUTCFullYear();
  const mo = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  const h = String(at.getUTCHours()).padStart(2, "0");
  const mi = String(at.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

const MINUTE_MS = 60_000;

/** Floor an instant to the start of its minute. The bucket a connection is
 * charged for is a span of wall clock, not an offset from when it opened. */
function floorToMinute(at: Date): number {
  return Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
}

/** How many minute buckets a connection has occupied, per period.
 *
 * A CONNECTION IS CHARGED FOR EVERY CALENDAR MINUTE IT WAS OPEN FOR ANY PART OF.
 * Open at 00:00:59 and closed at 00:01:01 is two seconds of wall clock and TWO
 * connection-minutes, because it was present in both minutes. A five-second
 * socket costs one. That charges reconnect churn, which summing seconds does
 * not, and it is the answer this chapter gives to the open question in
 * `docs/04-srs.md` about per-second precision.
 *
 * SPLIT BY PERIOD, because a socket open across midnight on the first owes
 * minutes to two months and each is credited independently (FR-RTL-05). The api is
 * never asked to do this arithmetic on the gateway's behalf: the wire carries one
 * entry per period, already decided.
 *
 * Counts from `openedAt`'s bucket through `at`'s INCLUSIVE, so a connection that
 * has just opened already owes its first minute. Returning zero for a fresh
 * socket would make a report for it indistinguishable from no report at all. */
export function bucketsFor(openedAt: Date, at: Date): Record<string, number> {
  const first = floorToMinute(openedAt);
  const last = floorToMinute(at);
  const totals: Record<string, number> = {};
  if (last < first) return totals;
  for (let ms = first; ms <= last; ms += MINUTE_MS) {
    const period = periodOf(new Date(ms));
    totals[period] = (totals[period] ?? 0) + 1;
  }
  return totals;
}

// --- the timer half -------------------------------------------------------

/** 60 seconds, to match the unit. A SECOND TIMER RATHER THAN THE HEARTBEAT'S:
 * `PING_INTERVAL_MS` is 30s because EIR-WS-04 wants a dead socket noticed
 * promptly, and billing cadence and liveness cadence are different requirements.
 * One number answering to both means the next change to either argues with the
 * other (research R10). */
export const METER_INTERVAL_MS = 60_000;

/** How many closed connections to hold before dropping the oldest.
 *
 * Bounded by closes since the last ACCEPTED report, not by time. At the default
 * interval a gateway would have to close four thousand sockets inside one minute
 * with the api unreachable to reach this, which is a mass disconnect during an
 * outage — and dropping the oldest under-counts, which is the same direction as
 * every other loss in this design and the opposite of billing for a socket
 * nobody holds. */
export const MAX_RETAINED_CLOSED = 4_000;

export interface Meter {
  /** A socket closed. Its final totals are handed over here, because the
   * registry has already forgotten it by the time anything else could ask
   * (research R19). */
  closed(connection: Connection, at: Date): void;
  /** Send one report for everything currently owed. Exposed for the timer, for
   * the shutdown flush, and for tests that drive their own clock. */
  reportOnce(at: Date): Promise<void>;
  /** How many closed connections are waiting for an accepted report. Zero for
   * open ones, always — they need no retention, because their next report
   * carries the same total plus whatever accrued. */
  retained(): number;
  /** How many entries were discarded at the cap. Counted rather than silent
   * (FR-RTL-05). */
  dropped(): number;
  stop(): void;
}

export interface MeterOptions {
  api: ApiClient;
  registry: Registry;
  logger: Logger;
  intervalMs?: number;
  now?: () => Date;
}

/** The meter (chapter 3.11).
 *
 * WHAT IT SENDS IS A TOTAL, NOT AN INCREMENT, and everything else here follows
 * from that. A lost report is repaired by the next one; a repeated one credits
 * nothing; a report that cannot be delivered is DROPPED rather than queued. The
 * gateway holds no outbox — which is the right amount of durable state for a
 * service designed to hold none (research R3).
 *
 * WITH ONE EXCEPTION, AND IT IS THE HONEST HALF OF THAT CLAIM. A connection that
 * has CLOSED has no next report to repair a lost one, so its final total is
 * retained until a report carrying it is accepted. R3's reasoning holds for open
 * connections and stops exactly here. */
export function createMeter({
  api,
  registry,
  logger,
  intervalMs = METER_INTERVAL_MS,
  now = () => new Date(),
}: MeterOptions): Meter {
  /** Keyed by `connection_id|period`, so a socket that spanned a month boundary
   * retains both of its entries and neither overwrites the other. */
  const closedEntries = new Map<string, InternalUsageReportEntry>();
  let discarded = 0;

  function entriesFor(
    connection: Connection,
    at: Date,
  ): InternalUsageReportEntry[] {
    return Object.entries(bucketsFor(connection.openedAt, at)).map(
      ([period, minutes]) => ({
        connection_id: connection.id,
        environment_id: connection.environmentId,
        period,
        minutes,
      }),
    );
  }

  function closed(connection: Connection, at: Date): void {
    for (const entry of entriesFor(connection, at)) {
      if (
        closedEntries.size >= MAX_RETAINED_CLOSED &&
        !closedEntries.has(`${entry.connection_id}|${entry.period}`)
      ) {
        // Oldest first — a Map iterates in insertion order, and the oldest
        // entry is the one whose minutes are least likely to still matter.
        const oldest = closedEntries.keys().next().value;
        if (oldest !== undefined) closedEntries.delete(oldest);
        discarded += 1;
        logger.log("error", "meter.retention_overflow", {
          discarded,
          retained: closedEntries.size,
        });
      }
      closedEntries.set(`${entry.connection_id}|${entry.period}`, entry);
    }
  }

  async function reportOnce(at: Date): Promise<void> {
    const open = registry.all().flatMap((c) => entriesFor(c, at));
    const closedNow = [...closedEntries.values()];
    const connections = [...closedNow, ...open];
    if (connections.length === 0) return;

    try {
      const answer = await api.reportUsage({ connections });
      // Null means no credential is configured, which is not an acceptance —
      // holding the closed entries would grow without bound in a gateway that
      // will never meter, so they go.
      if (answer === null) {
        closedEntries.clear();
        return;
      }
      // ACCEPTED. Only now do the closed ones go: their minutes are recorded and
      // nothing will carry them again.
      for (const entry of closedNow) {
        closedEntries.delete(`${entry.connection_id}|${entry.period}`);
      }
    } catch (error) {
      // A failed report closes nothing, refuses nothing, and fails nothing
      // (constitution III). Open connections need no action — their next report carries
      // the same total plus whatever accrued — and the closed ones stay.
      logger.log("error", "meter.report_failed", {
        connections: connections.length,
        retained: closedEntries.size,
        error: String(error),
      });
    }
  }

  const timer = setInterval(() => {
    void reportOnce(now());
  }, intervalMs);

  return {
    closed,
    reportOnce,
    retained: () => closedEntries.size,
    dropped: () => discarded,
    stop: () => clearInterval(timer),
  };
}
