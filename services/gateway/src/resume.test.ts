import { describe, expect, it } from "vitest";

import type { Message } from "@relay/protocol";

import {
  flushable,
  highWaterMarks,
  parseCursors,
  scopeCursors,
  scopeMarks,
  suppressed,
  withDeadline,
} from "./resume.js";

// The resume theorem, held still (chapter 2.7). Everything here is a pure
// function precisely so the ordering argument can be tested without a
// socket, a broker, or a database — session.test.ts then proves the
// orchestration, and resume.itest.ts proves it against a real Redis.

const CH = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function frame(channel: string, seq: number): Message {
  return {
    id: `id-${seq}`,
    channel,
    seq,
    user: "tuan",
    text: `m${seq}`,
    attachments: [],
    created_at: "2026-08-04T00:00:00.000Z",
  };
}

describe("parseCursors", () => {
  it("distinguishes a fresh connect from a resume with nothing new", () => {
    // undefined means "no cursor presented" — a first connect. An empty
    // object would mean "resume from the beginning", which is a different
    // instruction, and conflating the two costs a client its whole history.
    expect(parseCursors("/v1/ws?token=abc")).toBeUndefined();
    expect(parseCursors("/v1/ws")).toBeUndefined();
    expect(parseCursors(`/v1/ws?token=abc&cursor=${CH}:0`)).toEqual({ [CH]: 0 });
  });

  it("reads one cursor per channel", () => {
    expect(
      parseCursors(`/v1/ws?token=t&cursor=${CH}:41&cursor=${OTHER}:87`),
    ).toEqual({ [CH]: 41, [OTHER]: 87 });
  });

  it("splits on the LAST colon, so an id containing one survives", () => {
    expect(parseCursors("/v1/ws?cursor=weird:id:41")).toEqual({
      "weird:id": 41,
    });
  });

  it("returns null for anything it cannot trust", () => {
    for (const bad of [
      "/v1/ws?cursor=nocolon",
      "/v1/ws?cursor=:41",
      `/v1/ws?cursor=${CH}:notanumber`,
      `/v1/ws?cursor=${CH}:-1`,
      `/v1/ws?cursor=${CH}:1.5`,
      `/v1/ws?cursor=${CH}:41&cursor=broken`,
    ]) {
      expect(parseCursors(bad), bad).toBeNull();
    }
  });
});

describe("scopeCursors", () => {
  it("drops cursors for channels the caller is not in", () => {
    // A foreign channel id is a no-op, not a question the api gets asked
    // (constitution I) — and the bound on work per connect is membership.
    expect(scopeCursors({ [CH]: 41, [OTHER]: 9 }, new Set([CH]))).toEqual({
      [CH]: 41,
    });
  });
});

describe("highWaterMarks", () => {
  it("takes the last backfilled sequence per channel", () => {
    expect(
      highWaterMarks(
        { [CH]: 41, [OTHER]: 87 },
        { [CH]: { messages: [frame(CH, 42), frame(CH, 43)] } },
      ),
    ).toEqual({ [CH]: 43, [OTHER]: 87 });
  });

  it("keeps the presented cursor when a channel backfilled nothing", () => {
    // Nothing arrived while the client was away, so anything in the buffer
    // is genuinely new and must survive the flush.
    expect(highWaterMarks({ [CH]: 41 }, { [CH]: { messages: [] } })).toEqual({
      [CH]: 41,
    });
  });
});

describe("flushable", () => {
  it("keeps frames after the mark and discards the overlap", () => {
    const buffer = [frame(CH, 42), frame(CH, 43), frame(CH, 44)];
    expect(flushable(buffer, { [CH]: 43 }).map((f) => f.seq)).toEqual([44]);
  });

  it("discards the mark itself — `<=`, not `<`", () => {
    // H was delivered by the backfill. A buffered copy of H is the duplicate
    // this chapter exists to prevent, and it is exactly one character away.
    expect(flushable([frame(CH, 43)], { [CH]: 43 })).toEqual([]);
    expect(flushable([frame(CH, 44)], { [CH]: 43 }).map((f) => f.seq)).toEqual([
      44,
    ]);
  });

  it("marks are per channel, so a quiet channel's frames are not swallowed", () => {
    const buffer = [frame(CH, 10), frame(OTHER, 5)];
    expect(
      flushable(buffer, { [CH]: 43, [OTHER]: 4 }).map((f) => f.channel),
    ).toEqual([OTHER]);
  });

  it("treats an unknown channel's mark as 0 rather than dropping the frame", () => {
    // A channel joined DURING the resume has no cursor and no backfill. Its
    // frames are new by definition; the safe default is to deliver.
    expect(flushable([frame(OTHER, 1)], {}).map((f) => f.seq)).toEqual([1]);
  });
});

describe("withDeadline", () => {
  it("reports success, timeout, and rejection as a plain boolean", async () => {
    expect(await withDeadline(Promise.resolve(), 50)).toBe(true);
    expect(await withDeadline(new Promise(() => {}), 20)).toBe(false);
    // A rejected subscribe degrades the resume; it does not throw the
    // connection away.
    expect(await withDeadline(Promise.reject(new Error("redis down")), 50)).toBe(
      false,
    );
  });
});

// Chapter 3.7. `flushable` decides what a resuming connection may hand over from
// its buffer; `suppressed` decides what a LIVE connection must still refuse. The
// two comparisons are the same and the second one did not exist, which is the
// whole of the defect.
describe("suppressed", () => {
  const at = (channel: string, seq: number): Message => ({
    id: `id-${seq}`,
    channel,
    seq,
    user: "dispatcher",
    text: `m${seq}`,
    attachments: [],
    created_at: "2026-08-19T00:00:00.000Z",
  });

  it("suppresses a frame at the mark", () => {
    // `<=`, not `<`: the mark IS a sequence the backfill delivered.
    expect(suppressed({ a: 42 }, at("a", 42))).toBe(true);
  });

  it("suppresses a frame below the mark", () => {
    expect(suppressed({ a: 42 }, at("a", 7))).toBe(true);
  });

  it("delivers a frame above the mark", () => {
    // The half that matters most: suppression must never become a gap.
    expect(suppressed({ a: 42 }, at("a", 43))).toBe(false);
  });

  it("delivers on a channel with no mark", () => {
    expect(suppressed({ a: 42 }, at("b", 1))).toBe(false);
  });

  it("suppresses nothing when the connection never resumed", () => {
    expect(suppressed(null, at("a", 1))).toBe(false);
  });

  it("suppresses nothing when the mark set is empty", () => {
    expect(suppressed({}, at("a", 1))).toBe(false);
  });

  it("keeps channels apart", () => {
    // A mark on one channel must never silence another. Two connections' worth of
    // confusion would look exactly like message loss.
    const marks = { a: 42, b: 1 };
    expect(suppressed(marks, at("a", 40))).toBe(true);
    expect(suppressed(marks, at("b", 40))).toBe(false);
  });
});

describe("scopeMarks", () => {
  it("drops a channel the cursors never named", () => {
    // `highWaterMarks` adds a key for every channel the BACKFILL answered with.
    // The api derives its response from the cursors it was given, so this cannot
    // happen today — and a bound this service claims should not depend on another
    // service's response shape.
    expect(scopeMarks({ a: 42, surprise: 9 }, { a: 41 })).toEqual({ a: 42 });
  });

  it("keeps every channel the cursors did name", () => {
    expect(scopeMarks({ a: 42, b: 7 }, { a: 41, b: 1 })).toEqual({ a: 42, b: 7 });
  });

  it("never exceeds the cursor set, which the resume contract already caps", () => {
    const cursors = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`c${i}`, i]),
    );
    const marks = { ...cursors, extra: 1 };
    expect(Object.keys(scopeMarks(marks, cursors))).toHaveLength(200);
  });

  it("keeps a cursor far above anything the channel holds", () => {
    // A client-supplied cursor is checked only for being a non-negative integer.
    // A nonsense value seeds a mark rather than being clamped, and that is the
    // documented consequence rather than a defect: the client asserted it holds
    // those sequences, and the backfill has always taken that at face value.
    // The blast radius is one connection and reconnecting recovers it.
    expect(scopeMarks({ a: 999_999_999 }, { a: 999_999_999 })).toEqual({
      a: 999_999_999,
    });
  });
});
