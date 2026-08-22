import { describe, expect, it } from "vitest";

import { capsFor, NO_CAPS } from "./config";

describe("reading a dimension's caps out of quota_config", () => {
  it("reads a hard and a soft cap", () => {
    const { caps, error } = capsFor(
      { messages: { hard: 10_000, soft: 8_000 } },
      "messages",
    );
    expect(error).toBeNull();
    expect(caps).toEqual({ hard: 10_000, soft: 8_000 });
  });

  it("treats the column's default — an empty object — as no caps", () => {
    // Eighteen chapters of rows have `{}` in this column. None of them is
    // configured, and every one of them must keep sending.
    expect(capsFor({}, "messages").caps).toEqual(NO_CAPS);
  });

  it("treats an absent dimension as no caps", () => {
    expect(capsFor({ active_users: { hard: 5 } }, "messages").caps).toEqual(
      NO_CAPS,
    );
  });

  it("treats an explicit null as no cap", () => {
    expect(capsFor({ messages: { hard: null, soft: 9 } }, "messages").caps).toEqual(
      { hard: null, soft: 9 },
    );
  });

  it("keeps ZERO distinct from absent", () => {
    // Zero means refuse everything and must stay expressible — an environment can
    // be switched off deliberately (FR-RTL-06). This is the distinction chapter 3.8
    // needed nullable columns for, and it survives the move to jsonb.
    expect(capsFor({ messages: { hard: 0 } }, "messages").caps.hard).toBe(0);
    expect(capsFor({ messages: {} }, "messages").caps.hard).toBeNull();
  });

  it("fails closed on a malformed config, with a reason", () => {
    // A typo in an operator's configuration must not suspend a tenant. No caps,
    // and an error the caller logs.
    const { caps, error } = capsFor({ messages: { hard: -1 } }, "messages");
    expect(caps).toEqual(NO_CAPS);
    expect(error).not.toBeNull();
  });

  it("rejects a dimension nobody implemented rather than ignoring it", () => {
    // A config naming a dimension the system does not apply is a cap the
    // operator believes in and nothing enforces, which is worse than a refusal
    // to parse.
    //
    // THIS TEST NAMED `connection_minutes` UNTIL CHAPTER 3.11, with the comment
    // "until then". This is then — the dimension is implemented and the same
    // assertion would now be asserting the opposite of the truth. It moves to
    // `media_bytes`, which FR-MED-12 folds into quota enforcement in Part 4 and
    // which nothing applies today. The tripwire survives; only the dimension
    // standing on it changes.
    expect(capsFor({ media_bytes: { hard: 10 } }, "messages").error)
      .not.toBeNull();
  });

  it("survives null and undefined", () => {
    expect(capsFor(null, "messages").caps).toEqual(NO_CAPS);
    expect(capsFor(undefined, "messages").caps).toEqual(NO_CAPS);
  });
});

describe("the third dimension, and the two gates it has to pass (3.11)", () => {
  it("reads a connection_minutes cap", () => {
    const { caps, error } = capsFor(
      { connection_minutes: { hard: 50_000, soft: 40_000 } },
      "connection_minutes",
    );
    expect(error).toBeNull();
    expect(caps).toEqual({ hard: 50_000, soft: 40_000 });
  });

  it("still refuses a dimension nobody implemented", () => {
    // `.strict()` is the property being preserved here, not the key being added.
    const { caps, error } = capsFor({ media_bytes: { hard: 1 } }, "messages");
    expect(error).not.toBeNull();
    expect(caps).toEqual({ hard: null, soft: null });
  });

  it("FAILS CLOSED on a config the CHECK would accept and the parser will not", () => {
    // The migration's regex admits any run of digits, so a cap far past
    // `Number.MAX_SAFE_INTEGER` reaches this parser as a non-integer float. A
    // quota that cannot be read must refuse NOTHING rather than everything —
    // suspending a tenant over an operator's typo turns a mistake into an outage.
    const { caps, error } = capsFor(
      { connection_minutes: { hard: 1.5 } },
      "connection_minutes",
    );
    expect(error).not.toBeNull();
    expect(caps).toEqual({ hard: null, soft: null });
  });

  it("keeps absent, null and zero distinct for the new dimension", () => {
    expect(capsFor({}, "connection_minutes").caps).toEqual({ hard: null, soft: null });
    expect(
      capsFor({ connection_minutes: { hard: null } }, "connection_minutes").caps.hard,
    ).toBeNull();
    expect(
      capsFor({ connection_minutes: { hard: 0 } }, "connection_minutes").caps.hard,
    ).toBe(0);
  });
});
