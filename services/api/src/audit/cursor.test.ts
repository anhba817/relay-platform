import { describe, expect, it } from "vitest";

import { decodeAuditCursor, encodeAuditCursor } from "./cursor";

// THE REFUSALS, WHICH THE ROUTE SUITE CANNOT REACH. `route.itest.ts` sends one malformed
// cursor and gets a 400, which drives the first arm and leaves the other two: a token this
// module could have minted whose instant is outside anything the column can hold, and one
// whose id is the right shape and not a uuid. Both are reachable and neither had a test
// until the ratchet asked — chapter 4.13's `shape.ts`, raised rather than lowered.
//
// NO DATABASE. The cursor is arithmetic, so these run in the Docker-free lane.

const mint = (ms: number, id: string): string =>
  Buffer.from(`al:${ms}:${id}`, "utf8").toString("base64url");

const UUID = "aae5d625-4642-4710-a910-e703bf852190";

describe("the audit cursor round-trips", () => {
  it("decodes what it encoded, to the millisecond", () => {
    const at = { occurredAt: new Date("2026-10-02T09:14:22.013Z"), id: UUID };
    const back = decodeAuditCursor(encodeAuditCursor(at));
    expect(back?.occurredAt.toISOString()).toBe("2026-10-02T09:14:22.013Z");
    expect(back?.id).toBe(UUID);
  });

  it("accepts an upper-case id and returns it canonical", () => {
    // The pattern admits either case and the comparison downstream is against a `uuid`
    // column, so the value has to be normalised here rather than hoped about.
    const back = decodeAuditCursor(mint(Date.UTC(2026, 9, 2), UUID.toUpperCase()));
    expect(back?.id).toBe(UUID);
  });
});

describe("and refuses everything it did not produce", () => {
  it("refuses a token with no prefix, a wrong prefix, or nothing at all", () => {
    expect(decodeAuditCursor("not-a-cursor")).toBeNull();
    expect(decodeAuditCursor("")).toBeNull();
    // `rl:` is the REQUEST LOG's prefix. Two opaque cursors in one platform, and a client
    // holding the wrong one gets a refusal rather than somebody else's page.
    expect(
      decodeAuditCursor(Buffer.from(`rl:1759000000000:${UUID}`).toString("base64url")),
    ).toBeNull();
  });

  it("refuses an instant outside anything the column can hold", () => {
    // THE ARM THE RANGE CHECK EXISTS FOR, and the request log paid for learning that a
    // bound on the JavaScript number is not a bound on the instant: `999999999999999` is
    // a safe integer and decodes to the year 33658.
    expect(decodeAuditCursor(mint(999_999_999_999_999, UUID))).toBeNull();
    expect(decodeAuditCursor(mint(0, UUID))).toBeNull();
    expect(decodeAuditCursor(mint(Date.UTC(2025, 11, 31), UUID))).toBeNull();
    // and the first instant the table can hold is admitted
    expect(decodeAuditCursor(mint(Date.UTC(2026, 0, 1), UUID))).not.toBeNull();
  });

  it("refuses an id the outer pattern admits and `UUID` does not", () => {
    // THE FIXTURE HAS TO GET PAST THE FIRST PATTERN TO REACH THE SECOND, and the first
    // version of this test did not. It used `zzzzzzzz-4642-…`, which is 36 characters
    // and contains `z` — so `[0-9a-fA-F-]{36}` refuses it four lines earlier and the arm
    // this test is named for never ran. It passed, and CI's coverage reported
    // `cursor.ts` at 94.11 / 90 with line 72 uncovered while the pin said 100.
    //
    // What reaches it: 36 characters, all hex or hyphen, with the hyphens in the wrong
    // places. The outer pattern cannot see grouping and `UUID` can.
    const admitted = "aae5d6254642-4710-a910-e703bf8521901";
    expect(admitted).toHaveLength(36);
    expect(/^[0-9a-fA-F-]{36}$/.test(admitted), "the outer pattern must admit it").toBe(
      true,
    );
    expect(decodeAuditCursor(mint(Date.UTC(2026, 9, 2), admitted))).toBeNull();
  });
});
