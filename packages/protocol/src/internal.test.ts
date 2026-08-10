import { describe, expect, it } from "vitest";

import { ALL_EVENTS_SUBJECT, subjectFor } from "./internal.js";

// The subject grammar is ADR-02's, and a consumer that filters on a subject it
// assembled itself receives nothing the day the grammar drifts — silently. So
// the grammar is held here rather than trusted: the shape of a subject, the one
// abbreviation, the failure that must be loud, and the guarantee that whatever
// comes out is still reachable from the wildcard every consumer subscribes to.

/** `events.>` in NATS terms: everything below the prefix, at any depth. */
function matchesWildcard(subject: string, wildcard: string): boolean {
  const prefix = wildcard.replace(/>$/, "");
  return subject.startsWith(prefix) && subject.length > prefix.length;
}

describe("subjectFor builds ADR-02's `events.{domain}.{action}.{env}`", () => {
  it("puts the environment last", () => {
    expect(subjectFor("message.created", "env_123")).toBe(
      "events.msg.created.env_123",
    );
  });

  it("abbreviates `message` to `msg`, as ADR-02's own example does", () => {
    const subject = subjectFor("message.created", "env_123");
    expect(subject.split(".")[1]).toBe("msg");
  });

  it("passes a domain with no abbreviation through unchanged", () => {
    expect(subjectFor("channel.created", "env_123")).toBe(
      "events.channel.created.env_123",
    );
  });

  it("throws on a missing part instead of producing `events..created.`", () => {
    expect(() => subjectFor("", "env_123")).toThrow(/event type is required/);
    expect(() => subjectFor("message.created", "")).toThrow(
      /environment id is required/,
    );
  });

  it("produces subjects the consumer's wildcard matches", () => {
    for (const type of ["message.created", "channel.created"]) {
      expect(matchesWildcard(subjectFor(type, "env_123"), ALL_EVENTS_SUBJECT)).toBe(
        true,
      );
    }
  });
});
