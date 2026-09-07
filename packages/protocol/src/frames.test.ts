import { describe, expect, it } from "vitest";

import {
  connectionAckSchema,
  cursorSchema,
  frameSchema,
  MESSAGE_TEXT_MAX,
  messageDeletedSchema,
  messageSchema,
  parseFrame,
  revisionCountSchema,
} from "./frames.js";

// The contract must bite: for every frame, one specimen that parses and a
// table of malformed near-misses that MUST reject. A schema that accepts
// garbage is worse than no schema — it certifies garbage.

const message = {
  id: "m1",
  channel: "c1",
  seq: 42,
  user: "u1",
  text: "hello",
  // REQUIRED on `messageSchema`, so this fixture says. `[]` rather than a
  // populated list, because these tests are about the frame's SHAPE — the attachment's
  // own shape is `attachments.test.ts`'s subject and duplicating it here would give two
  // places to change when it moves.
  attachments: [],
  created_at: "2026-08-01T09:00:00.000Z",
};

const valid: Record<string, unknown> = {
  "connection.ack": {
    type: "connection.ack",
    // Feature 044: `revisions` is REQUIRED here, and this specimen went red the moment it
    // was added — which is the point. The ack is a frame the platform BUILDS, so required
    // is what makes every construction site name it. The attachments chapter's inverse case is the
    // one to keep straight: a reader of anything durable cannot require a field its writer
    // did not have, and `outboxEventSchema` learned that the expensive way.
    payload: {
      user: "u1",
      cursor: { c1: 42 },
      resume_ok: true,
      truncated: [],
      revisions: { c1: 7 },
    },
  },
  "message.send": {
    type: "message.send",
    payload: { idem_key: "k-1", channel: "c1", text: "hi" },
  },
  "message.ack": { type: "message.ack", payload: { seq: 43 } },
  "message.created": { type: "message.created", payload: message },
  "message.updated": { type: "message.updated", payload: message },
  // T015. THE ONE PINNED PLACE A PAYLOAD CHANGE MOVES in this file, and
  // the count and set assertions below do NOT move — the union's membership is unchanged,
  // so `toHaveLength(11)` and the inbound-set test stay green. Analysis pass 3 predicted
  // exactly this and pass 8's count confirmed it: one place, not three.
  "message.deleted": {
    type: "message.deleted",
    payload: {
      id: message.id,
      channel: message.channel,
      seq: message.seq,
      user: message.user,
      deleted_at: message.created_at,
    },
  },
  "membership.changed": {
    type: "membership.changed",
    payload: { channel: "c1", user: "u2", change: "added" },
  },
  "presence.changed": {
    type: "presence.changed",
    payload: { user: "u1", state: "online" },
  },
  typing: { type: "typing", payload: { channel: "c1", user: "u1" } },
  // And the only INBOUND member besides `message.send`. One
  // field: the connection supplies the user.
  "typing.send": { type: "typing.send", payload: { channel: "c1" } },
  error: {
    type: "error",
    payload: {
      code: "invalid_frame",
      message: "no",
      docs_url: "https://docs.example/errors/invalid_frame",
      // The fourth field, required rather than optional. The
      // comment above this schema promised it "joins in Part 2, when a gateway
      // exists to mint one" — Part 2 came and went, and constitution V has asked
      // for four fields since 1.3.
      request_id: "01JABCDEFGHJKMNPQRSTVWXYZ",
    },
  },
};

describe("every frame parses its valid specimen and round-trips", () => {
  for (const [name, frame] of Object.entries(valid)) {
    it(name, () => {
      const result = parseFrame(frame);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual(frame);
    });
  }
});

describe("malformed frames reject", () => {
  const rejects: Array<[string, unknown]> = [
    ["not an object", "message.send"],
    ["unknown type discriminator", { type: "message.destroy", payload: {} }],
    ["missing payload", { type: "message.ack" }],
    [
      "missing payload field",
      { type: "message.send", payload: { channel: "c1", text: "hi" } },
    ],
    [
      "wrong primitive (seq as string)",
      { type: "message.ack", payload: { seq: "43" } },
    ],
    ["zero seq", { type: "message.ack", payload: { seq: 0 } }],
    ["negative seq", { type: "message.ack", payload: { seq: -1 } }],
    [
      "empty idem_key",
      {
        type: "message.send",
        payload: { idem_key: "", channel: "c1", text: "hi" },
      },
    ],
    [
      "oversized idem_key",
      {
        type: "message.send",
        payload: { idem_key: "k".repeat(256), channel: "c1", text: "hi" },
      },
    ],
    [
      "unknown extra payload field",
      {
        type: "message.send",
        payload: { idem_key: "k-1", channel: "c1", text: "hi", admin: true },
      },
    ],
    [
      "invalid presence state",
      { type: "presence.changed", payload: { user: "u1", state: "away" } },
    ],
    [
      "non-RFC3339 timestamp",
      {
        type: "message.created",
        payload: { ...message, created_at: "yesterday" },
      },
    ],
  ];

  // THE `user` REJECTION IS THE SECURITY PROPERTY, not a schema
  // nicety: a client that could name a user could type as anybody (FR-006).
  rejects.push(
    [
      "typing.send naming a user",
      { type: "typing.send", payload: { channel: "c1", user: "someone-else" } },
    ],
    [
      "typing.send with an unknown field",
      { type: "typing.send", payload: { channel: "c1", renew: true } },
    ],
    ["typing.send with no channel", { type: "typing.send", payload: {} }],
    [
      "typing.send with an empty channel",
      { type: "typing.send", payload: { channel: "" } },
    ],
  );

  for (const [name, frame] of rejects) {
    it(name, () => {
      expect(parseFrame(frame).success).toBe(false);
    });
  }
});

// T014. THE COUNT AND THE SET, both asserted, on `codes.test.ts`'s precedent:
// an exact count makes a new member a decision rather than an accident, and an
// exact set makes it the RIGHT decision. The count alone would pass if somebody
// swapped one member for another.
// T015 and T016. THE EXACT KEY SET, on `codes.test.ts`'s precedent: an
// exact set is what makes a payload change a decision rather than an accident, and the
// only field that must NOT be there is the one this frame exists because it cannot fill.
describe("the message payload's exact key set (FR-022)", () => {
  it("names exactly seven, and attachments is one of them", () => {
    // SIX UNTIL THE ATTACHMENTS CHAPTER, and pinned here for the first time — the frame had no
    // exact-set assertion at all, so `messageSchema` was the one published payload a
    // silent addition could reach. `codes.test.ts` has pinned its set since the credentials chapter for the
    // same reason: an exact set makes a change a decision rather than an accident.
    const parsed = messageSchema.parse(message);
    expect(Object.keys(parsed).sort()).toEqual([
      "attachments",
      "channel",
      "created_at",
      "id",
      "seq",
      "text",
      "user",
    ]);
  });

  it("refuses a payload with no attachments key, because the field is required", () => {
    // The other half of FR-022. An OPTIONAL field would accept this, and a
    // construction site nobody widened would deliver a message whose attachments are
    // simply absent — green tests, silent loss.
    const withoutAttachments: Record<string, unknown> = { ...message };
    delete withoutAttachments["attachments"];
    expect(messageSchema.safeParse(withoutAttachments).success).toBe(false);
  });
});

describe("the deleted frame carries an identity and no text", () => {
  const tombstone = {
    id: message.id,
    channel: message.channel,
    seq: message.seq,
    user: message.user,
    deleted_at: message.created_at,
  };

  it("names exactly id, channel, seq, user and deleted_at", () => {
    const parsed = messageDeletedSchema.parse({
      type: "message.deleted",
      payload: tombstone,
    });
    expect(Object.keys(parsed.payload).sort()).toEqual([
      "channel",
      "deleted_at",
      "id",
      "seq",
      "user",
    ]);
  });

  it("refuses an ATTACHMENTS field, for the same reason it refuses text (FR-013)", () => {
    // The attachments chapter gave `messageSchema` a required attachments array, and the obvious
    // next move — symmetry — would be wrong here. A deletion's payload carries no text
    // because a payload with a text field is a payload that can carry the words somebody
    // asked to have removed; an attachment URL is exactly as recoverable. So this frame
    // keeps its five keys and the absence is the assertion.
    const withAttachments = messageDeletedSchema.safeParse({
      type: "message.deleted",
      payload: { ...tombstone, attachments: [] },
    });
    expect(withAttachments.success).toBe(false);
  });

  it("refuses a text field, because a deleted message has none", () => {
    // `z.strictObject`, so an extra key is an error rather than a silent drop. An empty
    // string would be worse than an error: a client could not tell a deleted message from
    // one somebody sent blank.
    const withText = messageDeletedSchema.safeParse({
      type: "message.deleted",
      payload: { ...tombstone, text: "" },
    });
    expect(withText.success).toBe(false);
  });

  // T016. QUICKSTART P2 AS AN ASSERTION, and the reason the payload changed at all.
  it("takes the same row `messageSchema` refuses for having no text", () => {
    const row = { ...message, text: null };
    expect(messageSchema.safeParse(row).success).toBe(false);
    expect(
      messageDeletedSchema.safeParse({
        type: "message.deleted",
        payload: tombstone,
      }).success,
    ).toBe(true);
  });
});

describe("the frame union's membership", () => {
  const members = frameSchema.options.map((o) => o.shape.type.value);

  it("has eleven members", () => {
    expect(members).toHaveLength(11);
  });

  it("names exactly two inbound frames, and both end in `.send`", () => {
    // The direction is not derivable from the schema — `isolation.itest.ts`'s
    // DIRECTIONS table is where it lives, and this asserts the naming rule that
    // makes the table's inbound rows predictable rather than remembered.
    expect(members.filter((m) => m.endsWith(".send")).sort()).toEqual([
      "message.send",
      "typing.send",
    ]);
  });

  it("keeps `typing` outbound-shaped: it carries a user and the inbound frame does not", () => {
    // FR-008: `typingSchema` is not edited by this chapter. The pair is the
    // proof — same subject, two frames, and only the server's has a `user`.
    expect(parseFrame({ type: "typing", payload: { channel: "c1" } }).success).toBe(
      false,
    );
    expect(
      parseFrame({ type: "typing.send", payload: { channel: "c1" } }).success,
    ).toBe(true);
  });
});

describe("the message-length maximum (feature 043, FR-008)", () => {
  const send = (text: string) =>
    parseFrame({
      type: "message.send",
      payload: { idem_key: "k1", channel: "c1", text },
    });

  it("refuses a socket send one character over the maximum", () => {
    // The door this feature closed. It was `z.string()` — no bound at all — so an
    // over-long text parsed here and was refused one hop later by the api's
    // `internalSendRequestSchema`, under a code that named the internal contract rather
    // than the field the customer wrote.
    expect(send("a".repeat(MESSAGE_TEXT_MAX)).success).toBe(true);
    expect(send("a".repeat(MESSAGE_TEXT_MAX + 1)).success).toBe(false);
  });

  it("names `payload.text` when it refuses, which is what the gateway sends as `field`", () => {
    // `session.ts` answers a failed frame parse with `invalid_frame` and
    // `issues[0].path.join(".")`. This asserts the path that produces, because the
    // field a customer sees is this array and not a string written anywhere.
    const result = send("a".repeat(MESSAGE_TEXT_MAX + 1));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path.join(".")).toBe("payload.text");
  });

  it("does NOT bound the outbound message, and that is deliberate", () => {
    // `messageSchema` is what the server EMITS, read off rows the platform already
    // stored. The attachments chapter's `outboxEventSchema` defect is the argument: a reader of
    // anything durable cannot impose a rule its writer did not have. Every stored row
    // came through a bounded door, so the bound buys nothing here and would turn a
    // hypothetical long row into an undeliverable one.
    //
    // This test exists because the task for FR-008 named THIS schema by line number.
    const long = {
      id: "m1",
      channel: "c1",
      seq: 1,
      user: "u1",
      text: "a".repeat(MESSAGE_TEXT_MAX + 1),
      attachments: [],
      created_at: "2026-09-06T00:00:00.000Z",
    };
    expect(messageSchema.safeParse(long).success).toBe(true);
  });
});

describe("the revision count on the ack (feature 044, FR-007, FR-009)", () => {
  const ack = (revisions: unknown) =>
    parseFrame({
      type: "connection.ack",
      payload: {
        user: "u1",
        cursor: { c1: 42 },
        resume_ok: true,
        truncated: [],
        revisions,
      },
    });

  it("accepts a count of ZERO, which is the whole reason it is not `cursorSchema`", () => {
    // The two schemas differ by one word — `.positive()` against `.nonnegative()` — and
    // the difference decides whether a never-revised channel can be reported at all.
    // Reusing `cursorSchema` would have forced the api to omit those channels, and an
    // omitted channel is indistinguishable from one the platform never mentioned, which
    // is exactly the pair FR-007 turns on.
    expect(ack({ c1: 0 }).success).toBe(true);
    expect(cursorSchema.safeParse({ c1: 0 }).success).toBe(false);
    // And the other direction still holds, so nothing was relaxed by accident: a cursor
    // of zero is still refused, because sequence numbering starts at one.
    expect(cursorSchema.safeParse({ c1: 1 }).success).toBe(true);
  });

  it("REQUIRES the field, because the platform is the one that builds it", () => {
    // The specimen above went red when this was added and was repaired rather than
    // relaxed. Required on a frame the server emits names every construction site; the
    // compiler cannot do that for an optional field.
    const withoutIt = connectionAckSchema.safeParse({
      type: "connection.ack",
      payload: { user: "u1", cursor: {}, resume_ok: true, truncated: [] },
    });
    expect(withoutIt.success).toBe(false);
  });

  it("refuses a negative count, a fractional one, and a string", () => {
    // A count that falls would silently tell a client it is up to date (FR-002), and a
    // fraction is not a number of revisions. Neither is reachable from the writer, which
    // is why the door is here rather than trusted upstream.
    expect(ack({ c1: -1 }).success).toBe(false);
    expect(ack({ c1: 1.5 }).success).toBe(false);
    expect(ack({ c1: "7" }).success).toBe(false);
  });

  it("does not require the cursor and the counts to name the same channels", () => {
    // The joined-during-absence case, at the schema layer. A client resuming presents a
    // cursor for the channels it held; the platform reports counts for every channel the
    // user belongs to, which is a superset. A schema that tied them together would make
    // the correct response unrepresentable.
    expect(ack({ c1: 3, c2: 0 }).success).toBe(true);
    // And the empty map, which is what a user in no channels gets.
    expect(ack({}).success).toBe(true);
  });

  it("exports the count schema on its own, not only as part of the ack", () => {
    // `internalSessionResponseSchema` reuses this rather than restating it. Two schemas
    // that must agree and are spelled twice are two schemas that will stop agreeing —
    // feature 043 found that with `editMessageBodySchema.text`, from the other side: two
    // that must DIFFER cannot share a reference at all.
    expect(revisionCountSchema.safeParse({ c1: 0 }).success).toBe(true);
    expect(revisionCountSchema.safeParse({ c1: -1 }).success).toBe(false);
  });
});
