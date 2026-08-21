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
    // be switched off deliberately (FR-006). This is the distinction chapter 3.8
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
    // `connection_minutes` is chapter 3.11. Until then a config naming it is a
    // cap the operator believes in and the system does not apply, which is worse
    // than a refusal to parse.
    expect(capsFor({ connection_minutes: { hard: 10 } }, "messages").error)
      .not.toBeNull();
  });

  it("survives null and undefined", () => {
    expect(capsFor(null, "messages").caps).toEqual(NO_CAPS);
    expect(capsFor(undefined, "messages").caps).toEqual(NO_CAPS);
  });
});
