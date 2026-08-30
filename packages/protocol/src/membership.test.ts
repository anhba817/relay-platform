import { describe, expect, it } from "vitest";

import { subjectForChannel } from "./fanout.js";
import {
  ALL_CHANNELS,
  membershipFabricSchema,
  subjectForChannelMembership,
  subjectForUserMembership,
} from "./membership.js";
import { subjectForPresence } from "./presence.js";

const CHANNEL = "ce419dc5-b06e-441c-ab38-49451f87210e";
const ENV = "3f2a0000-0000-0000-0000-000000000001";

describe("the subject grammars, together", () => {
  // FOUR SHAPES ON ONE REDIS AFTER THIS CHAPTER. Cross-kind mis-delivery is a
  // property of the topology rather than something a filter defends (FR-033), and
  // this is what proves the topology holds. Chapter 3.19 asserted the same thing
  // over two; a third and a fourth make it worth asserting pairwise rather than by
  // eye.
  it("gives four pairwise distinct subjects for the same id", () => {
    const subjects = [
      subjectForChannel(CHANNEL),
      subjectForPresence(CHANNEL),
      subjectForChannelMembership(CHANNEL),
      subjectForUserMembership(ENV, "tuan"),
    ];
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it("keeps the two membership shapes apart from each other", () => {
    // The channel-addressed and principal-addressed halves must not collide even
    // when a channel id and an environment id are the same string — which they can
    // be, since both are uuids from the same generator.
    expect(subjectForChannelMembership(ENV)).not.toBe(
      subjectForUserMembership(ENV, "tuan"),
    );
  });

  it("addresses a channel by its id and a user by environment and id", () => {
    expect(subjectForChannelMembership(CHANNEL)).toBe(`member:${CHANNEL}`);
    expect(subjectForUserMembership(ENV, "tuan")).toBe(`member:${ENV}:tuan`);
  });
});

describe("membershipFabricSchema", () => {
  const valid = {
    environment: ENV,
    channel: CHANNEL,
    user: "tuan",
    change: "removed" as const,
  };

  it("accepts both directions and no third", () => {
    expect(membershipFabricSchema.safeParse(valid).success).toBe(true);
    expect(
      membershipFabricSchema.safeParse({ ...valid, change: "added" }).success,
    ).toBe(true);
    // `role` is the one a reader expects to find here and it is not in the enum:
    // chapter 1.3 published two members and neither means "role".
    expect(
      membershipFabricSchema.safeParse({ ...valid, change: "role" }).success,
    ).toBe(false);
  });

  it("requires the environment the receiving gateway checks against", () => {
    // Built by omission rather than destructured away: this config does not treat a
    // leading underscore as "deliberately unused", so `const { environment: _x, …r }`
    // is a lint error rather than a convention.
    const withoutEnv = {
      channel: valid.channel,
      user: valid.user,
      change: valid.change,
    };
    expect(membershipFabricSchema.safeParse(withoutEnv).success).toBe(false);
  });

  it("rejects an unknown field instead of ignoring it", () => {
    // A field added on one side of a rolling deploy fails loudly on the other
    // rather than being dropped, which is what `strictObject` buys over `object`.
    expect(
      membershipFabricSchema.safeParse({ ...valid, role: "moderator" }).success,
    ).toBe(false);
  });

  it("admits a ban's all-channels sentinel", () => {
    // `channel` is `z.string().min(1)`, so `"*"` parses like any other value. The
    // schema cannot express "this is a sentinel" and the constant is what says so.
    expect(
      membershipFabricSchema.safeParse({ ...valid, channel: ALL_CHANNELS })
        .success,
    ).toBe(true);
  });
});
