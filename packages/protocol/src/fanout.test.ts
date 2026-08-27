import { describe, expect, it } from "vitest";

import { subjectForChannel } from "./fanout.js";

// THIS ASSERTION USED TO LIVE IN `services/gateway/src/fanout.itest.ts:150`,
// inside a suite that needs a running Redis. It is a pure string test: it needs
// no broker, no container and no lane. It moved here with the function in
// chapter 3.18, and it exists before the old copy is deleted so the property is
// never untested for the length of a commit.
describe("the fan-out subject grammar", () => {
  it("names one subject per channel", () => {
    expect(subjectForChannel("c1")).toBe("chan:c1");
  });

  it("is a prefix and the id, with nothing between them", () => {
    // The gateway subscribes with this and the api publishes with it. A change
    // to the separator, the prefix or the order silently stops delivery while
    // both sides keep working on their own — which is why the shape is pinned
    // rather than left to `chan:${id}` appearing twice in two repositories.
    const id = "954ff4f6-e4da-43ca-9988-6eb92d6e383a";
    expect(subjectForChannel(id)).toBe(`chan:${id}`);
    expect(subjectForChannel(id).startsWith("chan:")).toBe(true);
    expect(subjectForChannel(id).slice("chan:".length)).toBe(id);
  });

  it("does not interpret the id", () => {
    // No validation, no escaping, no lowercasing. The channel id is a UUID from
    // the repository by the time anything publishes, and a grammar that quietly
    // rewrote it would be a second source of truth for the subject.
    expect(subjectForChannel("")).toBe("chan:");
    expect(subjectForChannel("Mixed-Case_1")).toBe("chan:Mixed-Case_1");
  });
});
