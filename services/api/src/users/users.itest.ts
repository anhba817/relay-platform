import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { mintUserToken } from "../auth/user-token";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";

// THE LISTING, END TO END (chapter 3.15, FR-013 to FR-015, FR-022, SC-007).
//
// Every route in this suite names a user in the path and carries the TENANT's
// credential, so "the caller" here is the application and never the user named. That
// distinction is why FR-015 had to be restated: "a channel the caller is not a member
// of MUST NOT appear in their listing" is vacuous when the caller is an application
// key — a key is a member of nothing and an empty list satisfies it. The requirement
// is about the user the path names, and that is what these tests assert.

describe("a user's channel listing", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let credential: string;
  let repo: Repository;
  let member: { id: string };
  /** Three channels with staggered activity, oldest first in creation order. */
  let oldest: string;
  let middle: string;
  let newest: string;
  let notAMember: string;
  let publicNotAMember: string;
  let tokenFor: (subject: string) => Promise<string>;

  beforeAll(async () => {
    db = createDb(createPool());
    const env = await createEnvironment(db, { name: "users-itest" });
    repo = new Repository(db, env.id);
    credential = (await createApiKey(db, { environmentId: env.id })).credential;
    member = await repo.createUser("lister", "A Lister");

    // ACTIVITY IS ASSERTED BY SENDING, not by writing the column. The listing orders
    // by `last_activity_at` and the write path is what moves it; a fixture that set
    // the column directly would test the ordering against a value no send produced.
    const seed = async (label: string): Promise<string> => {
      const c = await repo.createChannel(label, "public");
      await repo.addMember(c.id, member.id);
      await repo.sendMessage(c.id, { text: `first in ${label}`, userId: member.id });
      return c.id;
    };
    oldest = await seed("oldest");
    middle = await seed("middle");
    newest = await seed("newest");

    // A private channel of the same tenant the user is NOT in, and a public one they
    // are not in either. The second is the one worth having: a public channel is
    // readable by any user of the tenant, so the read set and the listing set are
    // different sets and only a test says so.
    notAMember = (await repo.createChannel("private-elsewhere", "private")).id;
    publicNotAMember = (await repo.createChannel("public-elsewhere", "public")).id;

    const signingSecret = (await environmentSigningSecret(db, env.id))!.signingSecret;
    tokenFor = async (subject: string) =>
      (
        await mintUserToken(signingSecret, {
          user: subject,
          environmentId: env.id,
          ttlSeconds: 3600,
        })
      ).token;

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const list = (externalId: string, query = "", key = credential) =>
    fetch(`${url}/v1/users/${externalId}/channels${query}`, {
      headers: { authorization: `Bearer ${key}` },
    });

  // ── T112: the ordering (SC-007) ─────────────────────────────────────────────
  it("returns the user's channels, most recently active first", async () => {
    const res = await list("lister");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ external_id: string }> };
    expect(body.data.map((c) => c.external_id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("moves a channel to the front when it takes a message", async () => {
    await repo.sendMessage(oldest, { text: "back from the dead", userId: member.id });
    const body = (await (await list("lister")).json()) as {
      data: Array<{ external_id: string }>;
    };
    expect(body.data.map((c) => c.external_id)).toEqual(["oldest", "newest", "middle"]);
  });

  // ── T108: only a message is activity ────────────────────────────────────────
  //
  // THE TASK NAMED THREE NON-MESSAGE WRITES AND THIS PLATFORM HAS TWO. There is no
  // rename: `POST /v1/channels` is idempotent on the external id and its repeat
  // branch returns the existing row WITHOUT writing `name` or `metadata`, and no
  // other route or repository function updates them. So a rename cannot move the
  // column because a rename cannot happen — which is worth stating rather than
  // testing, and is the second task this feature has that named an operation the
  // platform does not have (T087's subscribe frame was the first).
  it("does not move for a join or an archive", async () => {
    const before = (await (await list("lister")).json()) as {
      data: Array<{ external_id: string; last_activity_at: string }>;
    };
    const stamps = new Map(before.data.map((c) => [c.external_id, c.last_activity_at]));

    // Two writes to these rows, neither of them a message.
    const joiner = await repo.createUser("joiner", "A Joiner");
    await repo.addMember(middle, joiner.id);
    await repo.archiveChannel(newest);

    const after = (await (await list("lister")).json()) as {
      data: Array<{ external_id: string; last_activity_at: string }>;
    };
    for (const c of after.data) {
      expect(c.last_activity_at, `${c.external_id} moved`).toBe(stamps.get(c.external_id));
    }
    // And the order is the order it was.
    expect(after.data.map((c) => c.external_id)).toEqual(before.data.map((c) => c.external_id));
    await repo.unarchiveChannel(newest);
  });

  // ── T114: membership is the listing set (FR-015) ─────────────────────────────
  it("omits a private channel the user is not a member of", async () => {
    const body = (await (await list("lister")).json()) as { data: Array<{ external_id: string }> };
    expect(body.data.map((c) => c.external_id)).not.toContain("private-elsewhere");
    expect(notAMember).toBeTruthy();
  });

  it("omits a PUBLIC channel the user is not a member of, which they could read by id", async () => {
    // The control for the assertion above: this channel is readable by this tenant's
    // users, so its absence from the listing is a decision and not an accident of
    // visibility. Without this test, "the listing only shows what you can see" would
    // pass and be the wrong rule.
    const readable = await fetch(`${url}/v1/channels/${publicNotAMember}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(readable.status).toBe(200);

    const body = (await (await list("lister")).json()) as { data: Array<{ external_id: string }> };
    expect(body.data.map((c) => c.external_id)).not.toContain("public-elsewhere");
  });

  // ── T115: an archived channel appears, with a flag (FR-022) ──────────────────
  it("lists an archived channel and says it is archived", async () => {
    await repo.archiveChannel(middle);
    const body = (await (await list("lister")).json()) as {
      data: Array<{ external_id: string; archived_at: string | null }>;
    };
    const row = body.data.find((c) => c.external_id === "middle");
    expect(row).toBeDefined();
    expect(row?.archived_at).not.toBeNull();
    // Every other channel reports null rather than the field being absent.
    expect(body.data.filter((c) => c.archived_at === null).length).toBe(
      body.data.length - 1,
    );
    await repo.unarchiveChannel(middle);
  });

  // ── T116b: the role is in the projection ────────────────────────────────────
  it("returns each channel's role for the user the path names", async () => {
    await repo.setMemberRole(newest, member.id, "moderator");
    const body = (await (await list("lister")).json()) as {
      data: Array<{ external_id: string; role: string }>;
    };
    expect(body.data.find((c) => c.external_id === "newest")?.role).toBe("moderator");
    expect(body.data.find((c) => c.external_id === "oldest")?.role).toBe("member");
    await repo.setMemberRole(newest, member.id, "member");
  });

  // ── T113: the cursor ────────────────────────────────────────────────────────
  //
  // THE TIE IS TESTED IN `repository.itest.ts` AND NOT HERE. Two channels sharing a
  // `last_activity_at` cannot be produced through the API: `now()` is the
  // transaction timestamp and every send is its own transaction, so constructing the
  // collision takes a raw UPDATE. `repository.itest.ts` is on the driver-exempt list
  // — the layer under test IS the query layer — and this suite is not. Adding a
  // `setLastActivityAt` to the repository to get around that would have put a method
  // in production code whose only caller is a test, in a feature about columns
  // nothing reads.
  it("pages through every channel exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
      const body = (await (await list("lister", q)).json()) as {
        data: Array<{ external_id: string }>;
        next_cursor: string | null;
      };
      seen.push(...body.data.map((c) => c.external_id));
      cursor = body.next_cursor;
      pages++;
      expect(pages, "the cursor did not terminate").toBeLessThan(20);
    } while (cursor !== null);

    expect(seen.length).toBe(new Set(seen).size);
    expect(new Set(seen)).toEqual(new Set(["oldest", "middle", "newest"]));
    expect(pages).toBeGreaterThan(1);
  });

  // ── T117: the cursor's refusals ─────────────────────────────────────────────
  it("refuses a malformed cursor with 400 and names the field", async () => {
    const res = await list("lister", "?cursor=not-a-cursor");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; field?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.field).toBe("cursor");
  });

  it("refuses a limit over 100 with 400 and names the field", async () => {
    const res = await list("lister", "?limit=101");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; field?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.field).toBe("limit");
  });

  it("answers a cursor naming another tenant's channel exactly as it answers an invented one", async () => {
    // T117 ASKED FOR 400 HERE AND 400 IS THE LEAK.
    //
    // The task's reason is right and its mechanism inverts it: "anything that
    // distinguishes 'exists elsewhere' from 'malformed' is the leak the suite exists
    // to catch". To answer 400 for a FOREIGN id, the server has to look the id up in
    // the global `channels` table and find it — and then a uuid that exists in
    // another tenant gets a different answer from a uuid that exists nowhere. That is
    // the distinction SC-002 forbids, built on purpose.
    //
    // So the cursor is validated for SHAPE and its id is never resolved. A keyset
    // position does not have to exist: `(last_activity_at, id) < (ts, id)` is a
    // comparison, not a lookup. A foreign id, an invented uuid and the id of a
    // channel deleted since the cursor was minted all name the same position in this
    // tenant's ordering, and all three get the same page.
    //
    // The lookup would also break a real client: a user removed from a channel
    // between pages would find their cursor rejected mid-pagination.
    const other = new Repository(
      db,
      (await createEnvironment(db, { name: "users-itest-foreign" })).id,
    );
    const theirs = await other.createChannel("theirs", "public");
    const at = new Date().toISOString();
    const cursorOf = (id: string) =>
      Buffer.from(JSON.stringify({ a: at, id }), "utf8").toString("base64url");

    const foreign = await list("lister", `?cursor=${cursorOf(theirs.id)}`);
    const invented = await list(
      "lister",
      `?cursor=${cursorOf("00000000-0000-4000-8000-000000000000")}`,
    );
    expect(foreign.status).toBe(invented.status);
    expect(await foreign.text()).toBe(await invented.text());
  });

  // ── T109c: unknown fields are refused, not ignored ───────────────────────────
  it("refuses an unknown query field rather than ignoring it", async () => {
    const res = await list("lister", "?limit=2&Limit=3");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
  });

  // ── T111: a user who does not exist, and one who is deleted ──────────────────
  it("answers 404 for a user this tenant does not have", async () => {
    expect((await list("nobody")).status).toBe(404);
  });

  it("answers 404 for a deleted user", async () => {
    const doomed = await repo.createUser("doomed", "Doomed");
    await repo.addMember(oldest, doomed.id);
    expect((await list("doomed")).status).toBe(200);
    await repo.markUserDeleted(doomed.id);
    expect((await list("doomed")).status).toBe(404);
  });

  // ══ THE UNREAD COUNT (chapter 3.15, FR-016 to FR-018, SC-008) ═══════════════

  const setRead = (user: string, channelId: string, sequence: number, key = credential) =>
    fetch(`${url}/v1/users/${user}/channels/${channelId}/read`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ sequence }),
    });

  const unreadFor = async (user: string, external: string): Promise<number> => {
    const body = (await (await list(user, "?limit=100")).json()) as {
      data: Array<{ external_id: string; unread: number }>;
    };
    return body.data.find((c) => c.external_id === external)!.unread;
  };

  // ── T122: it rises, and it falls to zero (SC-008) ───────────────────────────
  it("rises with each message and falls to zero when the position reaches the end", async () => {
    const c = await repo.createChannel("counting", "public");
    await repo.addMember(c.id, member.id);
    const sender = await repo.createUser("sender", "A Sender");
    await repo.addMember(c.id, sender.id);

    expect(await unreadFor("lister", "counting")).toBe(0);
    const first = await repo.sendMessage(c.id, { text: "one", userId: sender.id });
    expect(await unreadFor("lister", "counting")).toBe(1);
    await repo.sendMessage(c.id, { text: "two", userId: sender.id });
    const third = await repo.sendMessage(c.id, { text: "three", userId: sender.id });
    expect(await unreadFor("lister", "counting")).toBe(3);
    expect(first.seq).toBe(1);

    const res = await setRead("lister", c.id, third.seq);
    expect(res.status).toBe(200);
    expect(await unreadFor("lister", "counting")).toBe(0);
  });

  // ── T123: no row means position zero (FR-017a) ───────────────────────────────
  it("gives a new member the channel's whole history as unread, seeding nothing", async () => {
    const c = await repo.createChannel("pre-existing", "public");
    const author = await repo.createUser("author", "An Author");
    await repo.addMember(c.id, author.id);
    for (const t of ["a", "b", "c", "d"]) {
      await repo.sendMessage(c.id, { text: t, userId: author.id });
    }
    // The member arrives AFTER the history exists.
    const late = await repo.createUser("latecomer", "A Latecomer");
    await repo.addMember(c.id, late.id);
    expect(await unreadFor("latecomer", "pre-existing")).toBe(4);
  });

  // ── T123a: the re-added member gets the same answer (T059a, moved here) ──────
  it("gives a re-added member the whole history again, because removal took the position", async () => {
    const c = await repo.createChannel("rejoined", "public");
    const author = await repo.createUser("rejoin-author", "Author");
    await repo.addMember(c.id, author.id);
    const rejoiner = await repo.createUser("rejoiner", "A Rejoiner");
    await repo.addMember(c.id, rejoiner.id);
    await repo.sendMessage(c.id, { text: "one", userId: author.id });
    const two = await repo.sendMessage(c.id, { text: "two", userId: author.id });
    await setRead("rejoiner", c.id, two.seq);
    expect(await unreadFor("rejoiner", "rejoined")).toBe(0);

    await repo.removeMembers(c.id, [rejoiner.id]);
    await repo.addMember(c.id, rejoiner.id);

    // TWO, NOT ZERO. Removal deleted the read position with the membership, so there
    // is no row, and no row means zero — the same rule a brand-new member gets. The
    // alternative, keeping the position through a removal, would mean a re-added
    // member silently misses everything sent while they were out.
    expect(await unreadFor("rejoiner", "rejoined")).toBe(2);
  });

  // ── T126: a sender's own message, and the answer is not the assumed one ──────
  //
  // THE SPEC ASSUMED "a user's own message is read by them" and left the scenario as
  // "whether it counts as unread for its author is stated and tested". Measured: it
  // COUNTS. The write path does not advance the sender's own read position, so a user
  // who sends a message sees their own unread count go to one until they acknowledge it.
  //
  // NOT CHANGED, and the reason is the cost of where it would go. Advancing the position
  // server-side is a second statement on a second table inside the send transaction —
  // the platform's highest-frequency operation, forever, for every attributed message.
  // `last_activity_at` was put in the statement that already updates `channels` for
  // exactly this reason; a read-position upsert has no statement to join.
  //
  // The client pays nothing instead: the send response already carries the sequence it
  // just wrote, so acknowledging is one field it already holds. And the public REST send
  // attributes no user at all, so a server-side advance would work on some sends and not
  // others — the worst of the three options.
  it("does raise the sender's own count until they acknowledge it", async () => {
    const c = await repo.createChannel("own-messages", "public");
    const talker = await repo.createUser("talker", "A Talker");
    await repo.addMember(c.id, talker.id);
    const sent = await repo.sendMessage(c.id, { text: "hello", userId: talker.id });

    // ONE, not zero. This is the assertion that would have been hidden by a test that
    // acknowledged first and then checked for zero — which is what this test did until
    // the count was measured rather than assumed.
    expect(await unreadFor("talker", "own-messages")).toBe(1);

    await setRead("talker", c.id, sent.seq);
    expect(await unreadFor("talker", "own-messages")).toBe(0);
  });

  // ── T125: the refusals ───────────────────────────────────────────────────────
  it("refuses a position past the channel's last message with 400 and names the field", async () => {
    const c = await repo.createChannel("past-the-end", "public");
    await repo.addMember(c.id, member.id);
    await repo.sendMessage(c.id, { text: "only one", userId: member.id });
    const res = await setRead("lister", c.id, 99);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; field?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.field).toBe("sequence");
  });

  it("accepts a replayed lower position as a 200 that changes nothing", async () => {
    const c = await repo.createChannel("replayed", "public");
    await repo.addMember(c.id, member.id);
    await repo.sendMessage(c.id, { text: "one", userId: member.id });
    const two = await repo.sendMessage(c.id, { text: "two", userId: member.id });
    expect((await setRead("lister", c.id, two.seq)).status).toBe(200);

    const replay = await setRead("lister", c.id, 1);
    expect(replay.status).toBe(200);
    // The stored position is unchanged, which is the whole point: a client replaying an
    // old acknowledgement must not move the count backwards.
    expect(((await replay.json()) as { sequence: number }).sequence).toBe(two.seq);
    expect(await unreadFor("lister", "replayed")).toBe(0);
  });

  // ── T120: whose membership the refusal is about ─────────────────────────────
  it("refuses a public channel the PATH'S USER is not a member of with not_a_member", async () => {
    // The caller is an application credential, which is a member of nothing. If the
    // refusal were about the caller, every one of these calls would fail.
    const res = await setRead("lister", publicNotAMember, 0);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("not_a_member");
  });

  it("answers 404 for a private channel the path's user is not a member of", async () => {
    // NOT 403. `not_a_member` on a private channel would announce that it exists, which
    // is the leak the four attack shapes exist to catch. This is the one route in the
    // feature that emits `not_a_member` at all, and only for public channels.
    const res = await setRead("lister", notAMember, 0);
    expect(res.status).toBe(404);
  });

  it("takes a user token as well as an application credential", async () => {
    // The only route on this controller that does: a user records their own position.
    // Method-level `@Accepts` wins over the class-level one, which is the mechanism
    // chapter 3.12 built and this is the first route to rely on it.
    const c = await repo.createChannel("own-token", "public");
    await repo.addMember(c.id, member.id);
    const one = await repo.sendMessage(c.id, { text: "one", userId: member.id });
    const res = await setRead("lister", c.id, one.seq, await tokenFor("lister"));
    expect(res.status).toBe(200);
  });
});
