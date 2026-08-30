import { describe, expect, it } from "vitest";

import { ALL_CHANNELS, DEFAULT_REREAD_INTERVAL_MS } from "./membership.js";

// PURE LOGIC ONLY, and that is this file's whole shape. `createMembership` builds its
// own Redis client from a url and cannot be handed a double, so anything
// reply-dependent lives in `membership.itest.ts`. `presence.test.ts` and
// `limits.test.ts` are the precedents.

describe("the backstop interval", () => {
  it("is the sixty seconds the arithmetic chose", () => {
    // NFR-SCL-01 budgets 10,000 connections per instance, so this is 167 re-reads per
    // second per instance and five seconds would be 2,000. The number is asserted
    // here rather than left as a bare constant so a later change to it is a decision
    // somebody made rather than a diff nobody read.
    expect(DEFAULT_REREAD_INTERVAL_MS).toBe(60_000);
  });

  it("is far longer than the clause it backs up, and that is the point", () => {
    // FR-RTM-10's five seconds is met by the publish. This bounds the damage when a
    // publish is DROPPED, which is a rarer event and a different budget — reading
    // them as one number is how a backstop turns into a poll.
    expect(DEFAULT_REREAD_INTERVAL_MS).toBeGreaterThan(5_000);
  });
});

describe("the all-channels sentinel", () => {
  it("is a value no channel id can collide with", () => {
    // Channel ids are uuids. `"*"` is not one, which is what makes a sentinel inside
    // a `z.string().min(1)` safe rather than merely convenient.
    expect(ALL_CHANNELS).toBe("*");
    expect(ALL_CHANNELS).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
