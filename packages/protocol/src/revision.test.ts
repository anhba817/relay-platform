import { describe, expect, it } from "vitest";

import {
  isChannelRevisionSubject,
  channelOfRevision,
  logFieldsOfRevision,
  revisionFabricSchema,
  subjectForChannelRevision,
} from "./revision.js";
import { subjectForChannel } from "./fanout.js";

// T018d. THE SUBJECT STRING AND THE PAYLOAD'S EXACT KEYS, on
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
  // THE COMPILER DID NOT FIND THIS ONE: `revisionFabricSchema.parse`
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

describe("the revision subject (ADR-24)", () => {
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

describe("the revision fabric payload", () => {
  it("takes an edit as a whole message", () => {
    const parsed = revisionFabricSchema.parse({ kind: "updated", message });
    // NARROWED BEFORE READING `message`, because chapter 4.14's third arm does not have
    // one. `expect(parsed.kind)` alone does not narrow for the compiler, and `pnpm
    // build` never said so: `tsconfig.build.json` excludes tests, so only
    // `pnpm typecheck` reaches this file.
    if (parsed.kind !== "updated") throw new Error("expected the updated arm");
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
    if (parsed.kind !== "deleted") throw new Error("expected the deleted arm");
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

describe("the third arm: a transition of an object a message references (4.14)", () => {
  const MEDIA = "b61bfdfb-b42e-4e95-a1ed-2bedd3a4ed21";
  const CHANNEL = "6f1d2e3a-4b5c-4d6e-8f90-a1b2c3d4e5f6";
  const arm = { kind: "media", media_id: MEDIA, channel: CHANNEL, state: "ready" } as const;

  it("parses, and its channel is a field rather than a message's", () => {
    expect(revisionFabricSchema.parse(arm)).toEqual(arm);
  });

  // `pending` IS A STATE THE PRODUCER CANNOT EMIT. The frame announces a transition out
  // of it, so admitting it would be a value nothing can reach — `0018`'s argument for
  // refusing a fourth value in the column, applied to the wire.
  it("refuses state pending, which no transition can announce", () => {
    expect(revisionFabricSchema.safeParse({ ...arm, state: "pending" }).success).toBe(false);
  });

  it("refuses an unknown key, like both older arms", () => {
    expect(
      revisionFabricSchema.safeParse({ ...arm, reason: "scan_failed" }).success,
    ).toBe(false);
  });

  it("refuses an unknown kind rather than guessing", () => {
    expect(revisionFabricSchema.safeParse({ ...arm, kind: "media.v2" }).success).toBe(false);
  });
});

describe("channelOfRevision answers for every arm (4.14)", () => {
  const CHANNEL = "6f1d2e3a-4b5c-4d6e-8f90-a1b2c3d4e5f6";

  // Eight production sites reached through `revision.message.channel` before the media
  // arm existed. This is the one place that knows which field each arm keeps it in.
  it("reads a media arm's own channel field", () => {
    expect(
      channelOfRevision({
        kind: "media",
        media_id: "b61bfdfb-b42e-4e95-a1ed-2bedd3a4ed21",
        channel: CHANNEL,
        state: "rejected",
      }),
    ).toBe(CHANNEL);
  });

  it("omits message_id for a media arm rather than logging undefined", () => {
    const fields = logFieldsOfRevision({
      kind: "media",
      media_id: "b61bfdfb-b42e-4e95-a1ed-2bedd3a4ed21",
      channel: CHANNEL,
      state: "ready",
    });
    expect(fields).toEqual({ channel: CHANNEL, kind: "media" });
    expect("message_id" in fields).toBe(false);
  });
});
