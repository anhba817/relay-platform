import { describe, expect, it } from "vitest";

import { subjectForChannel } from "./fanout.js";
import {
  subjectForChannelMembership,
  subjectForUserMembership,
} from "./membership.js";
import { subjectForPresence } from "./presence.js";
import { subjectForTyping, typingFabricSchema } from "./typing.js";

describe("subjectForTyping", () => {
  it("is `typing:` and the channel id", () => {
    expect(subjectForTyping("c1")).toBe("typing:c1");
  });

  it("passes the id through untouched, including a uuid", () => {
    const id = "7a1f5c2e-0b3d-4e6a-9c8b-1d2e3f4a5b6c";
    expect(subjectForTyping(id)).toBe(`typing:${id}`);
  });
});

// T022. FIVE BUILDERS, PAIRWISE DISTINCT FOR THE SAME ID.
//
// Cross-kind mis-delivery is a property of the TOPOLOGY, not of any one module,
// and this is the test that holds the topology. Four fabrics now share one Redis:
// a message, a presence transition, two membership shapes and a typing signal can
// all name channel `c1` in the same second, and every subscriber is listening on
// a string. If two builders ever agreed, a gateway would parse one kind's payload
// with another kind's schema — and `strictObject` would turn that into
// `*.invalid_payload` on every publish rather than anything a reader could trace.
//
// The environment-scoped builder takes two arguments, so it is fed the same id in
// both positions: the point is that no output collides, and feeding it something
// unrelated would weaken the test rather than the topology.
describe("the five subject grammars, together", () => {
  const id = "c1";
  const builders: ReadonlyArray<readonly [string, string]> = [
    ["chan", subjectForChannel(id)],
    ["presence", subjectForPresence(id)],
    ["member:channel", subjectForChannelMembership(id)],
    ["member:user", subjectForUserMembership(id, id)],
    ["typing", subjectForTyping(id)],
  ];

  it("produces five distinct subjects for one id", () => {
    const subjects = builders.map(([, subject]) => subject);
    expect(new Set(subjects).size).toBe(builders.length);
  });

  it("gives every pair a different string", () => {
    for (const [nameA, a] of builders) {
      for (const [nameB, b] of builders) {
        if (nameA === nameB) continue;
        expect(a, `${nameA} and ${nameB} collide on \`${a}\``).not.toBe(b);
      }
    }
  });

  it("keeps typing's prefix off every other grammar", () => {
    // A prefix collision is the one a `new Set` cannot see: `psubscribe` and any
    // future wildcard read would match across grammars even where the exact
    // strings differ.
    const others = builders
      .filter(([name]) => name !== "typing")
      .map(([, subject]) => subject);
    for (const subject of others) {
      expect(subject.startsWith("typing:")).toBe(false);
    }
  });
});

describe("typingFabricSchema", () => {
  const valid = { environment: "env_1", channel: "c1", user: "u1" };

  it("accepts the three fields the fabric carries", () => {
    expect(typingFabricSchema.safeParse(valid).success).toBe(true);
  });

  it("requires an environment", () => {
    expect(
      typingFabricSchema.safeParse({ channel: "c1", user: "u1" }).success,
    ).toBe(false);
  });

  it("rejects an empty environment rather than treating it as absent", () => {
    expect(
      typingFabricSchema.safeParse({ ...valid, environment: "" }).success,
    ).toBe(false);
  });

  it("rejects an unknown field instead of ignoring it", () => {
    // The whole reason for `strictObject`: a field added on one side of a rolling
    // deploy fails loudly on the other rather than being silently dropped.
    expect(
      typingFabricSchema.safeParse({ ...valid, state: "started" }).success,
    ).toBe(false);
  });

  it("rejects a `state` field in particular, which is the one somebody will add", () => {
    // Named separately from the test above because this is not a hypothetical
    // unknown field. `typing.start`/`typing.stop` is the design this protocol
    // does not have, and a `state` on the fabric would be its first half.
    const result = typingFabricSchema.safeParse({ ...valid, state: "stopped" });
    expect(result.success).toBe(false);
  });
});
