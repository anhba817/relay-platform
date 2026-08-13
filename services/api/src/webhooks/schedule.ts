// The retry schedule (chapter 3.5, FR-WHK-03).
//
// Seven attempts — one immediate, then FR-WHK-03's six retries — and the delays
// are data rather than arithmetic. An exponential
// formula would be shorter and would not let each step carry its reason — and
// the reasons are the part a reader needs, because "exponential backoff" is a
// shape, not a decision.
//
// ---------------------------------------------------------------------------
// DECISION (chapter 3.5, taken by the author on 2026-08-10): FR-WHK-03 is
// internally inconsistent, and this is the reading taken.
//
// It says: "Failed deliveries shall be retried with exponential backoff at
// approximately 1 s, 5 s, 30 s, 5 min, 30 min, 2 h — six attempts in total."
//
// Six delays are listed, and an initial delivery followed by six retries is
// SEVEN requests — which the same sentence's "six attempts in total" forbids.
// The two halves cannot both be satisfied.
//
// THE DELAY LIST WINS. "Six attempts" is read as the six RETRIES, which is how
// the sentence's first clause uses the word ("shall be retried ... at"), and it
// keeps every number the requirement actually names — including the 2 h tier
// that gives a customer a working day's outage before their events are
// dead-lettered. Dropping that tier to preserve a count would have quietly
// shortened the platform's most customer-visible promise from two hours to
// thirty-six minutes.
//
// So: attempt 1 is immediate, attempts 2-7 follow at 1 s, 5 s, 30 s, 5 min,
// 30 min and 2 h, and the schedule spans about two hours thirty-six minutes.
//
// The SRS wording should be corrected to say "six retries" rather than "six
// attempts in total"; that is an amendment, not a chapter's decision to take
// alone, and it is recorded here until it happens.
//
// Worth noticing that this switch cost one table entry and one constant. The
// column, the relay and every invariant were untouched — which is a property of
// R1's re-plan, where the schedule stopped being broker state and became data.
// ---------------------------------------------------------------------------

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Delay before each attempt, indexed by `attempt - 1`.
 *
 * `attempt` is the INDEX INTO THIS TABLE, not a free-running counter. That is
 * what makes recomputing `next_attempt_at` total rather than incremental: given
 * a delivery row, the next due time is a lookup, and a bug in one branch cannot
 * leave a delivery drifting on a schedule nobody can reconstruct. */
export const RETRY_TIERS_MS: readonly number[] = [
  // Attempt 1 — immediate. A webhook that waits before its FIRST try would make
  // every customer's integration feel broken for a reason none of them could
  // see.
  0,
  // 1 s — the deploy-restart tier. Most first failures are a customer's process
  // being replaced, and a second is long enough for the new one to be listening.
  1 * SECOND,
  // 5 s — the transient tier: a connection reset, a cold lambda, a brief 502.
  5 * SECOND,
  // 30 s — long enough that a customer's own retry-and-recover has had a turn.
  30 * SECOND,
  // 5 min — the deploy tier: long enough for a rollback or a restart to have
  // finished, rather than catching a customer mid-deploy twice.
  5 * MINUTE,
  // 30 min — past here the endpoint is not blinking, it is down, and a human is
  // already involved on the customer's side.
  30 * MINUTE,
  // 2 h — the last one, and the reason the delay list won over the count. It
  // gives a customer most of a working day's outage to be noticed and fixed
  // before their events stop being retried at all. Anything still failing here
  // needs the dead-letter store and its seven days.
  2 * HOUR,
];

/** Seven requests: the initial delivery plus FR-WHK-03's six retries.
 * Exceeding it dead-letters. */
export const MAX_ATTEMPTS = RETRY_TIERS_MS.length;

/** When attempt N falls due, measured from the moment its predecessor failed.
 *
 * Returns null when there is no attempt N — the caller's signal to dead-letter
 * rather than to schedule. Making "no next tier" a value rather than an
 * exception keeps the outcome path a single expression. */
export function nextAttemptAt(attempt: number, from: Date = new Date()): Date | null {
  if (attempt < 1 || attempt > MAX_ATTEMPTS) return null;
  const delay = RETRY_TIERS_MS[attempt - 1];
  if (delay === undefined) return null;
  return new Date(from.getTime() + delay);
}
