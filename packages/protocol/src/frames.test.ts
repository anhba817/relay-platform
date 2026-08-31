import { describe, expect, it } from "vitest";

import { frameSchema, parseFrame } from "./frames.js";

// The contract must bite: for every frame, one specimen that parses and a
// table of malformed near-misses that MUST reject. A schema that accepts
// garbage is worse than no schema — it certifies garbage.

const message = {
  id: "m1",
  channel: "c1",
  seq: 42,
  user: "u1",
  text: "hello",
  created_at: "2026-08-01T09:00:00.000Z",
};

const valid: Record<string, unknown> = {
  "connection.ack": {
    type: "connection.ack",
    payload: { user: "u1", cursor: { c1: 42 }, resume_ok: true, truncated: [] },
  },
  "message.send": {
    type: "message.send",
    payload: { idem_key: "k-1", channel: "c1", text: "hi" },
  },
  "message.ack": { type: "message.ack", payload: { seq: 43 } },
  "message.created": { type: "message.created", payload: message },
  "message.updated": { type: "message.updated", payload: message },
  "message.deleted": { type: "message.deleted", payload: message },
  "membership.changed": {
    type: "membership.changed",
    payload: { channel: "c1", user: "u2", change: "added" },
  },
  "presence.changed": {
    type: "presence.changed",
    payload: { user: "u1", state: "online" },
  },
  typing: { type: "typing", payload: { channel: "c1", user: "u1" } },
  // Chapter 3.21, and the only INBOUND member besides `message.send`. One
  // field: the connection supplies the user.
  "typing.send": { type: "typing.send", payload: { channel: "c1" } },
  error: {
    type: "error",
    payload: {
      code: "invalid_frame",
      message: "no",
      docs_url: "https://docs.example/errors/invalid_frame",
      // Chapter 3.8: the fourth field, required rather than optional. The
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

  // Chapter 3.21. THE `user` REJECTION IS THE SECURITY PROPERTY, not a schema
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
describe("the frame union's membership (chapter 3.21)", () => {
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
