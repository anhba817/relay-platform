// The fixed-window arithmetic (chapter 3.8, research R1).
//
// FIXED WINDOW, NOT A TOKEN BUCKET, and the SAD's own row is why the question
// arose: §6.3 lists `rl:{env}:{bucket}` as "Token buckets" with a TTL of
// "window", which are two different algorithms. The TTL column wins, for three
// reasons in order of weight.
//
// `X-RateLimit-Reset` decides it. The header names the moment an allowance
// returns, and a fixed window has exactly one. A continuously refilling bucket
// does not — the honest answer to "when do I have my full allowance back" is a
// curve, and the header is an integer. A limiter whose reset header is a lie
// fails FR-RTL-02 in the way that matters, because that requirement exists so a
// client can schedule against it.
//
// Then atomicity: `INCR` returns the new value on its own and `EXPIRE` on the
// first increment gives the window. Two commands, no Lua, no read-modify-write
// race between api instances.
//
// Then cleanup: the key expires when its window ends, so nothing accumulates.
// That matters more than it sounds — chapter 3.7 spent a baseline on four suites
// that broke because a shared store grew without bound, and this chapter's own
// baseline found a fifth.
//
// THE COST, stated rather than hidden: up to twice the limit across a boundary.
// 600 in the last instant of one window and 600 in the first instant of the next
// is 1,200 inside two minutes. The limit bounds sustained load; it does not
// smooth instantaneous rate. `bucket.test.ts` asserts it so the claim is checked
// rather than merely written down.
//
// Everything here is pure and takes the instant it should reason about. Nothing
// reads a clock, so a boundary is a test rather than a wait.

/** The window an instant belongs to, floored — and the key's own suffix.
 *
 * Two api instances compute this from the same wall clock and agree without
 * talking to each other, which is what closes the clock-skew case by
 * construction. A stored reset time would be a value they could disagree about,
 * and `Retry-After` is exactly where that disagreement would surface. */
export function windowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/** When the allowance returns: the end of the current window, in milliseconds.
 *
 * One moment, which is the whole argument for this algorithm over a bucket that
 * refills. Never in the past — the window an instant belongs to always ends
 * after it. */
export function resetAt(nowMs: number, windowMs: number): number {
  return windowStart(nowMs, windowMs) + windowMs;
}

/** How many operations are left, after counting the one in hand.
 *
 * Clamped at zero. A limit lowered while a window is open — an operator dropping
 * an environment from 600 to 2 with forty already counted — would otherwise
 * produce `-38`, and a client would parse that as a number and act on it. Zero
 * is both true and safe. */
export function remaining(count: number, limit: number): number {
  return Math.max(0, limit - count);
}
