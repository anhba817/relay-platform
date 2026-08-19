import type { Message } from "@relay/protocol";

// The resume sequence (chapter 2.7, SAD §5.2). The order is LOAD-BEARING:
//
//   1 subscribe   — from this instant, no frame can be missed
//   2 buffer      — but none may be delivered yet: it might duplicate
//                   something the backfill is about to send
//   3 backfill    — seq > cursor per channel from the api, capped; emit in
//                   sequence order; note the high-water mark H per channel
//   4 flush       — emit buffered frames with seq > H; DISCARD seq <= H
//   5 live        — normal 2.6 delivery from here on
//
// Either naive ordering loses. Backfill-then-subscribe drops whatever was
// published during the backfill window — the fabric is at-most-once with no
// memory (2.6 made that a feature), so the frame is simply gone, and the
// client believes it is current. Subscribe-then-deliver double-sends the
// overlap. The fix is not a better order: it is overlap plus dedup. We buy
// completeness with redundancy and repay the redundancy with one integer
// comparison, which is most of why sequences exist (ADR-03).
//
// This file is deliberately pure — parsing, marks, partitioning. The
// orchestration lives in session.ts, where the socket is; the theorem lives
// here, where a unit test can hold it still.

/** A connection is either holding frames back or handing them over. The
 * middle of a resume is the only time the first state exists. */
export type ResumePhase = "buffering" | "live";

/** How many live frames one resuming connection may hold. A resume is
 * milliseconds; a channel that produces 500 frames inside it is a channel
 * the client should be paging history for, not streaming. */
export const MAX_BUFFERED_FRAMES = 500;

/** How long the fabric gets to confirm subscriptions before resume gives
 * up on being safe. 2.6 forbade AWAITING the subscribe on the handshake —
 * a stopped broker must not block a connect — and resume needs it awaited
 * to close the gap. Both rules survive with a deadline: wait briefly, and
 * if the fabric will not confirm, say so honestly (`resume_ok: false`)
 * instead of pretending the gap is closed. */
export const SUBSCRIBE_DEADLINE_MS = 500;

/** Cursors ride the upgrade URL: `?cursor=<channel_id>:<seq>`, repeated.
 * They arrive with the handshake because EIR-WS-03's ack must already carry
 * the truncation list — the server cannot report what it has not fetched.
 *
 * Returns null for a malformed set, which the caller turns into a degraded
 * resume rather than a rejected connection: a client whose stored cursor
 * got corrupted can recover by refetching history, but a client closed at
 * the door can only reconnect and be closed again.
 */
export function parseCursors(
  url: string,
): Record<string, number> | null | undefined {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const raw = new URLSearchParams(query).getAll("cursor");
  if (raw.length === 0) return undefined; // a fresh connect, not a resume
  const cursors: Record<string, number> = {};
  for (const entry of raw) {
    // rsplit: channel ids are opaque to the gateway and a colon inside one
    // must not silently truncate it.
    const split = entry.lastIndexOf(":");
    if (split <= 0) return null;
    const channelId = entry.slice(0, split);
    const seq = Number(entry.slice(split + 1));
    if (!Number.isInteger(seq) || seq < 0) return null;
    cursors[channelId] = seq;
  }
  return cursors;
}

/** Cursors the caller has no business resuming are dropped before the api
 * is asked. Membership is the api's truth (ADR-05) and it re-checks; this
 * is about not turning one connect into a thousand index scans, and about
 * a foreign channel id being a no-op rather than a question. */
export function scopeCursors(
  cursors: Record<string, number>,
  channelIds: Set<string>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(cursors).filter(([channelId]) => channelIds.has(channelId)),
  );
}

/** The backfill's high-water mark per channel: the last sequence the
 * client is about to have. Channels absent from the backfill keep their
 * presented cursor as the mark — nothing new arrived, so anything buffered
 * is genuinely new. */
export function highWaterMarks(
  cursors: Record<string, number>,
  backfilled: Record<string, { messages: Message[] }>,
): Record<string, number> {
  const marks: Record<string, number> = { ...cursors };
  for (const [channelId, page] of Object.entries(backfilled)) {
    const last = page.messages[page.messages.length - 1];
    if (last) marks[channelId] = last.seq;
  }
  return marks;
}

/** Step 4. `<=` and not `<`: H itself was just delivered by the backfill,
 * so a buffered copy of H is a duplicate. Off-by-one here is user-visible —
 * the same seam lesson 2.4's exclusive anchors taught, third appearance. */
export function flushable(
  buffer: Message[],
  marks: Record<string, number>,
): Message[] {
  return buffer.filter((frame) => frame.seq > (marks[frame.channel] ?? 0));
}

/** Step 5's half, and the reason this chapter exists (FR-001, FR-003).
 *
 * `flushable` answers this question for frames sitting in the buffer. This answers
 * it for frames arriving AFTER the connection has gone live, which is the case
 * chapter 2.7 did not have — its marks were a local variable that `resume()`
 * discarded the moment it flushed.
 *
 * A message is durable at one instant and announced at another: the gateway
 * commits through the api and only then publishes to the fabric. A backfill query
 * landing between those two instants returns a message the fabric has not yet
 * delivered, so the delivery arrives once the resume is over — and before this
 * function there was nothing left to compare it against.
 *
 * `<=`, not `<`. The mark IS a sequence the backfill delivered rather than the one
 * after it, which is the same off-by-one `flushable` documents one screen up. */
export function suppressed(
  marks: Record<string, number> | null,
  frame: Message,
): boolean {
  if (marks === null) return false;
  const mark = marks[frame.channel];
  return mark !== undefined && frame.seq <= mark;
}

/** The marks a connection keeps, bounded to the channels it actually presented
 * cursors for (FR-007).
 *
 * `highWaterMarks` seeds from the cursors and then adds a key for every channel
 * the backfill answered with, so on its own it bounds nothing. The api derives its
 * response from the cursors it was given, so the two agree today — but a bound
 * this service claims should not live in another service's response shape. This is
 * `scopeCursors` applied one step later, and it is here rather than in `session.ts`
 * so that a unit test can reach it.
 *
 * At most `MAX_RESUME_CHANNELS` entries, because that is what the resume contract
 * already caps the cursor map at. */
export function scopeMarks(
  marks: Record<string, number>,
  cursors: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(marks).filter(([channelId]) => channelId in cursors),
  );
}

/** A promise that resolves false instead of hanging forever. */
export async function withDeadline(
  work: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    // A REJECTION is a false, not a throw: the caller's decision is the same
    // either way — resume cannot promise completeness — and a rejected
    // subscribe must not take the connection down with it.
    return await Promise.race([
      work.then(
        () => true,
        () => false,
      ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
