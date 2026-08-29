import { describe, expect, it } from "vitest";

import { subjectForChannel } from "./fanout.js";
import { presenceFabricSchema, subjectForPresence } from "./presence.js";

describe("subjectForPresence", () => {
  it("is one subject per channel, prefixed to keep it off the message path", () => {
    expect(subjectForPresence("c1")).toBe("presence:c1");
  });

  // NOT A TASTE ASSERTION. The whole argument for a second subject grammar is
  // that a presence payload can never arrive where a message parse is waiting.
  // That property is topology, not vigilance — and it holds only while the two
  // grammars cannot collide for the same channel id.
  it("never collides with the message subject for the same channel", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    expect(subjectForPresence(id)).not.toBe(subjectForChannel(id));
  });
});

describe("presenceFabricSchema", () => {
  const valid = { user: "tuan", state: "online", transition: "t-1" };

  it("accepts a transition", () => {
    expect(presenceFabricSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a state the clause does not name", () => {
    // FR-RTM-06 says `online` and `offline`. `frames.test.ts` already rejects
    // "away" on the wire frame; this is the same refusal one layer down.
    expect(
      presenceFabricSchema.safeParse({ ...valid, state: "away" }).success,
    ).toBe(false);
  });

  it("rejects a payload with no transition", () => {
    expect(
      presenceFabricSchema.safeParse({ user: valid.user, state: valid.state })
        .success,
    ).toBe(false);
  });

  // `strictObject` rather than `object`. A field added on one side of a rolling
  // deploy must fail loudly on the other rather than be dropped in silence.
  it("rejects an unknown field instead of ignoring it", () => {
    expect(
      presenceFabricSchema.safeParse({ ...valid, channel: "c1" }).success,
    ).toBe(false);
  });
});
