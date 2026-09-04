import { describe, expect, it } from "vitest";

import {
  isChannelRevisionSubject,
  revisionFabricSchema,
  subjectForChannelRevision,
} from "./revision.js";
import { subjectForChannel } from "./fanout.js";

// T018d (chapter 3.23). THE SUBJECT STRING AND THE PAYLOAD'S EXACT KEYS, on
// `codes.test.ts`'s precedent: an exact set is what makes a change to either a decision
// rather than an accident.
//
// A SUBJECT IS A PUBLISHED NAME. Two instances agree on it by spelling, so a typo is a
// silent no-delivery rather than an error — which is why the four grammars before this one
// each pinned their string in a test.

const message = {
  id: "m1",
  channel: "c1",
  seq: 7,
  user: "tuan",
  text: "corrected",
  // Chapter 3.24. THE COMPILER DID NOT FIND THIS ONE: `revisionFabricSchema.parse`
  // takes `unknown`, so a fixture handed to it is invisible to `tsc` no matter what
  // the schema requires. T014a's instrument named 33 construction sites and this was
  // not among them — the unit lane found it.
  attachments: [],
  created_at: "2026-09-03T00:00:00.000Z",
};

const tombstone = {
  id: "m1",
  channel: "c1",
  seq: 7,
  user: "tuan",
  deleted_at: "2026-09-03T00:00:00.000Z",
};

describe("the revision subject (chapter 3.23, ADR-24)", () => {
  it("is `revision:{channelId}`", () => {
    expect(subjectForChannelRevision("c1")).toBe("revision:c1");
  });

  it("is not any of the four grammars that came before it", () => {
    // `chan:`, `member:`, `presence:`, `typing:`. A fifth that collided with one of them
    // would deliver message revisions to a subscriber expecting something else.
    const subject = subjectForChannelRevision("c1");
    for (const taken of ["chan:", "member:", "presence:", "typing:"]) {
      expect(subject.startsWith(taken)).toBe(false);
    }
  });

  it("recognises its own subjects and no others", () => {
    // The gateway's subscriber holds `chan:` and `revision:` on ONE client and routes on
    // the subject, so this predicate is what stands between an edit and being parsed as a
    // creation. The negative case is the one that matters: `subjectForChannel` is the
    // other subject on that same client.
    expect(isChannelRevisionSubject(subjectForChannelRevision("c1"))).toBe(true);
    expect(isChannelRevisionSubject(subjectForChannel("c1"))).toBe(false);
    // A channel id that merely CONTAINS the word is not a revision subject. Only the
    // prefix counts, and only with its colon.
    expect(isChannelRevisionSubject("chan:revision:c1")).toBe(false);
    expect(isChannelRevisionSubject("revisionc1")).toBe(false);
  });
});

describe("the revision fabric payload (chapter 3.23)", () => {
  it("takes an edit as a whole message", () => {
    const parsed = revisionFabricSchema.parse({ kind: "updated", message });
    expect(parsed.kind).toBe("updated");
    expect(Object.keys(parsed.message).sort()).toEqual([
      "attachments",
      "channel",
      "created_at",
      "id",
      "seq",
      "text",
      "user",
    ]);
  });

  it("takes a deletion as an identity with no text", () => {
    const parsed = revisionFabricSchema.parse({ kind: "deleted", message: tombstone });
    expect(parsed.kind).toBe("deleted");
    expect(Object.keys(parsed.message).sort()).toEqual([
      "channel",
      "deleted_at",
      "id",
      "seq",
      "user",
    ]);
  });

  it("refuses a deletion that carries a text", () => {
    // The whole reason this grammar exists. `strictObject` makes the extra key an error
    // rather than a silent drop, so a producer that reached for `messageSchema` fails here
    // instead of putting a lie on the fabric.
    expect(
      revisionFabricSchema.safeParse({
        kind: "deleted",
        message: { ...tombstone, text: "" },
      }).success,
    ).toBe(false);
  });

  it("refuses an edit with no text, and a kind it does not know", () => {
    expect(
      revisionFabricSchema.safeParse({ kind: "updated", message: tombstone }).success,
    ).toBe(false);
    expect(
      revisionFabricSchema.safeParse({ kind: "created", message }).success,
    ).toBe(false);
  });
});
