// When to stop trying (chapter 3.6, FR-007).
//
// This file is the chapter's only arithmetic, and it is separated from both places
// that call it deliberately. One trigger runs inside a database transaction and
// the other runs inside a background loop; a policy living in either would be
// testable only with a database, a clock and a broker, and "should this endpoint be
// switched off" is a question that needs none of the three.
//
// The two numbers are FIXED, not configuration, and that is FR-007's own wording
// rather than an omission. An operator who can lower the floor to one has an
// operator who can disable a paying customer's endpoint on a single bad response —
// and the failure mode of configuration here is silent, since nobody notices a
// threshold that is too aggressive until the endpoints are already off.

/** ONE HOUR, from FR-WHK-07's "failing continuously for more than an hour". */
export const DISABLE_AFTER_MS = 60 * 60 * 1_000;

/** FIVE attempts, and the number comes from measurement rather than taste
 * (research R3).
 *
 * The hour alone is not enough. Chapter 3.5's schedule reaches a two-hour gap
 * between attempts, so ONE failure followed by silence satisfies "failing for
 * more than an hour" with a single data point — and disabling on one bad response
 * is what the floor exists to prevent.
 *
 * Five is the largest floor a single failing delivery can still clear inside the
 * window. Computed against `RETRY_TIERS_MS = [0, 1s, 5s, 30s, 5min, 30min, 2h]`,
 * measured from the first attempt:
 *
 *     attempt 5  at +5m36s    inside the hour
 *     attempt 6  at +35m36s   inside the hour
 *     attempt 7  at +2h35m36s OUTSIDE it
 *
 * So a floor of 5 or 6 is reachable by one delivery and a floor of 7 is not: set
 * it to 7 and a single-delivery run could never trigger, which would leave the
 * quietest endpoints — the ones least likely to be watched — enabled and failing
 * for ever. Five leaves a margin of one.
 *
 * Below 5 the floor stops doing its job: two or three failures are reachable in
 * the first six seconds, and six seconds of trouble is a blip rather than an
 * outage. */
export const DISABLE_MIN_ATTEMPTS = 5;

export interface FailureRun {
  /** When the current unbroken run of failures began. Null when the endpoint is
   * healthy — any success clears it. */
  runStartedAt: Date | null;
  /** How many failures the run contains. Null when healthy. */
  runAttempts: number | null;
  /** Passed in rather than read, so this function has no clock of its own. Every
   * caller has one already: the on-outcome trigger is inside a transaction that
   * knows `now()`, and the sweep is a loop that just woke up. */
  now: Date;
}

/** Should this endpoint be switched off?
 *
 * Both conditions, never either: longer than an hour AND at least five failures.
 * The run must also exist — a healthy endpoint is not a candidate, and the two
 * nulls are how "healthy" is spelled. */
export function shouldDisable({
  runStartedAt,
  runAttempts,
  now,
}: FailureRun): boolean {
  if (runStartedAt === null || runAttempts === null) return false;
  if (runAttempts < DISABLE_MIN_ATTEMPTS) return false;
  return runWindowMs({ runStartedAt, now }) > DISABLE_AFTER_MS;
}

/** How long the run has been going, and never a negative number.
 *
 * The clamp is not defensive padding. A clock that moves backwards — an NTP
 * correction, a container resumed from a snapshot, a replica whose time differs
 * from the writer's — would otherwise produce a negative window, and a negative
 * window compared against a positive threshold reads as "not yet", which is the
 * safe direction only by accident. Clamping makes the answer "no time has passed"
 * rather than "time has run backwards", which is a claim the rest of the code can
 * reason about. Spec edge case, stated there before it was written here. */
export function runWindowMs({
  runStartedAt,
  now,
}: {
  runStartedAt: Date;
  now: Date;
}): number {
  return Math.max(0, now.getTime() - runStartedAt.getTime());
}

/** The sentence a customer reads, and the reason FR-009 asks for one.
 *
 * "Disabled" on its own invites a support ticket. This says what the platform saw,
 * over how long, and what the endpoint last answered — enough for the customer to
 * recognise their own outage without being told to check a dashboard that does not
 * exist yet. */
export function disableReason({
  runAttempts,
  windowMs,
  lastStatus,
  lastError,
}: {
  runAttempts: number;
  windowMs: number;
  lastStatus: number | null;
  lastError: string | null;
}): string {
  const answered =
    lastStatus !== null
      ? `last status ${lastStatus}`
      : lastError !== null
        ? // Bounded, because this string goes in a column a customer reads and the
          // error it quotes came from a machine we do not own. The seam already
          // caps the error at 2000 characters; a reason is a sentence, not a log.
          `no response (${lastError.slice(0, 200)})`
        : "no response";
  return `${runAttempts} consecutive failures over ${humanDuration(windowMs)}; ${answered}`;
}

/** `1h04m`. Minutes, because the threshold is an hour and seconds would be noise
 * — and because a reason that said `3862000ms` would be a message written for the
 * platform rather than for the person reading it. */
function humanDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}
