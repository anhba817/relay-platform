import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { mintUserToken } from "../auth/user-token";
import { periodOf } from "../quotas/period";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
  usageFor,
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
  let environmentId: string;

  beforeAll(async () => {
    db = createDb(createPool());
    const env = await createEnvironment(db, { name: "users-itest" });
    environmentId = env.id;
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

  // ══ THE PROFILE (chapter 3.15, FR-023, FR-024, SC-011) ══════════════════════

  const profile = (user: string, key = credential) =>
    fetch(`${url}/v1/users/${user}`, { headers: { authorization: `Bearer ${key}` } });

  const patchProfile = (user: string, body: unknown, key = credential) =>
    fetch(`${url}/v1/users/${user}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });

  // ── T131: the round trip, all three fields (SC-011) ─────────────────────────
  it("round-trips display name, avatar url and metadata", async () => {
    await repo.createUser("profiled", "Before");
    const res = await patchProfile("profiled", {
      display_name: "After",
      avatar_url: "https://cdn.example.com/a/b.png",
      metadata: { team: "support", tier: 3 },
    });
    expect(res.status).toBe(200);

    const body = (await (await profile("profiled")).json()) as {
      external_id: string;
      display_name: string | null;
      avatar_url: string | null;
      metadata: Record<string, unknown>;
    };
    expect(body).toEqual({
      external_id: "profiled",
      display_name: "After",
      avatar_url: "https://cdn.example.com/a/b.png",
      metadata: { team: "support", tier: 3 },
    });
  });

  it("patches one field without clearing the others", async () => {
    await patchProfile("profiled", { display_name: "Renamed" });
    const body = (await (await profile("profiled")).json()) as {
      display_name: string | null;
      avatar_url: string | null;
      metadata: Record<string, unknown>;
    };
    // ABSENT IS NOT NULL. The two fields left out of the patch keep their values.
    expect(body.display_name).toBe("Renamed");
    expect(body.avatar_url).toBe("https://cdn.example.com/a/b.png");
    expect(body.metadata).toEqual({ team: "support", tier: 3 });
  });

  it("clears a field when the patch names it null", async () => {
    await patchProfile("profiled", { avatar_url: null });
    const body = (await (await profile("profiled")).json()) as { avatar_url: string | null };
    expect(body.avatar_url).toBeNull();
  });

  it("accepts an empty patch and changes nothing", async () => {
    const before = await (await profile("profiled")).text();
    const res = await patchProfile("profiled", {});
    expect(res.status).toBe(200);
    expect(await (await profile("profiled")).text()).toBe(before);
  });

  // ── T132: FR-024's two bounds, each naming its field ────────────────────────
  it("refuses metadata over 4 KB with 400 and names the field", async () => {
    const res = await patchProfile("profiled", {
      metadata: { blob: "x".repeat(4 * 1024) },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; field?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.field).toBe("metadata");
  });

  it("accepts metadata just under 4 KB", async () => {
    // THE CONTROL FOR THE BOUND. Without it, a refusal that rejected all metadata would
    // pass the test above.
    const res = await patchProfile("profiled", { metadata: { blob: "x".repeat(4_000) } });
    expect(res.status).toBe(200);
  });

  it("refuses a malformed avatar url with 400 and names the field", async () => {
    const res = await patchProfile("profiled", { avatar_url: "not-a-url" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; field?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.field).toBe("avatar_url");
  });

  it("refuses an unknown profile field rather than ignoring it", async () => {
    const res = await patchProfile("profiled", { displayName: "camelCase" });
    expect(res.status).toBe(400);
  });

  // ── T129: a deleted user has no profile, on both routes ──────────────────────
  it("answers 404 on both profile routes for a deleted user", async () => {
    const gone = await repo.createUser("profile-deleted", "Going");
    expect((await profile("profile-deleted")).status).toBe(200);
    await repo.markUserDeleted(gone.id);
    expect((await profile("profile-deleted")).status).toBe(404);
    expect((await patchProfile("profile-deleted", { display_name: "x" })).status).toBe(404);
  });

  it("answers 404 for a user this tenant does not have", async () => {
    expect((await profile("nobody-at-all")).status).toBe(404);
  });

  // ══ THE BULK UPSERT AND THE DELETION (FR-025 to FR-030, SC-012) ═════════════

  const upsert = (users: unknown, key = credential) =>
    fetch(`${url}/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ users }),
    });

  const removeUser = (user: string, key = credential) =>
    fetch(`${url}/v1/users/${user}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });

  // ── T138: 100 accepted, 101 refused (SC-012) ────────────────────────────────
  it("upserts 100 users in one request", async () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      external_id: `bulk-${i}`,
      display_name: `Bulk ${i}`,
    }));
    const res = await upsert(entries);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ status: string }> };
    expect(body.data).toHaveLength(100);
    expect(body.data.every((e) => e.status === "created")).toBe(true);
  });

  it("refuses 101 with 400 and names the field", async () => {
    const entries = Array.from({ length: 101 }, (_, i) => ({ external_id: `over-${i}` }));
    const res = await upsert(entries);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; field?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.field).toBe("users");
  });

  // ── T139: an existing user is UPDATED, not refused (FR-026) ──────────────────
  it("updates an entry that names an existing user", async () => {
    await upsert([{ external_id: "bulk-updatable", display_name: "First" }]);
    const res = await upsert([
      { external_id: "bulk-updatable", display_name: "Second", metadata: { seen: 2 } },
    ]);
    const body = (await res.json()) as {
      data: Array<{ status: string; display_name: string | null }>;
    };
    // `updated`, and the name actually moved. This is where `upsertUser` differs from
    // `createUser`, whose whole comment is about NOT doing this: the member-add asks for
    // membership and must not rename anybody, and this route's subject IS the user.
    expect(body.data[0]!.status).toBe("updated");
    expect(body.data[0]!.display_name).toBe("Second");
    const read = (await (await profile("bulk-updatable")).json()) as {
      display_name: string | null;
      metadata: Record<string, unknown>;
    };
    expect(read.display_name).toBe("Second");
    expect(read.metadata).toEqual({ seen: 2 });
  });

  it("leaves a field the entry omits alone", async () => {
    await upsert([{ external_id: "bulk-partial", display_name: "Name", metadata: { a: 1 } }]);
    await upsert([{ external_id: "bulk-partial", metadata: { a: 2 } }]);
    const read = (await (await profile("bulk-partial")).json()) as {
      display_name: string | null;
      metadata: Record<string, unknown>;
    };
    expect(read.display_name).toBe("Name");
    expect(read.metadata).toEqual({ a: 2 });
  });

  // ── T140: a failing entry names its index ───────────────────────────────────
  it("names the failing entry's index in the field path", async () => {
    const entries: unknown[] = Array.from({ length: 9 }, (_, i) => ({
      external_id: `indexed-${i}`,
    }));
    entries[7] = { external_id: "indexed-7", metadata: { blob: "x".repeat(4 * 1024) } };
    const res = await upsert(entries);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field?: string };
    // `users.7.metadata` — the index, not just the leaf. A caller sending 100 entries
    // cannot act on "metadata is too big" without being told which one.
    expect(body.field).toBe("users.7.metadata");
  });

  // ── T143, T145: what the deletion keeps and what it takes ───────────────────
  it("keeps the row, the messages and their attribution, and takes the rest", async () => {
    const doomed = await repo.createUser("deletable", "Doomed");
    const channel = await repo.createChannel("deletion-witness", "public");
    await repo.addMember(channel.id, doomed.id);
    const sent = await repo.sendMessage(channel.id, {
      text: "still here afterwards",
      userId: doomed.id,
      userExternalId: "deletable",
    });
    await setRead("deletable", channel.id, sent.seq);
    await patchProfile("deletable", {
      avatar_url: "https://cdn.example.com/doomed.png",
      metadata: { doomed: true },
    });

    expect((await removeUser("deletable")).status).toBe(200);

    // THE MESSAGE IS STILL THERE AND STILL THEIRS (FR-028). The history route is the
    // reader; `user` is the external id the send recorded.
    const history = await fetch(
      `${url}/v1/channels/${channel.id}/messages?limit=10`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    const messages = (await history.json()) as {
      messages: Array<{ seq: number; text: string | null; user: string | null }>;
    };
    const mine = messages.messages.find((m) => m.seq === sent.seq);
    expect(mine?.text).toBe("still here afterwards");
    // ATTRIBUTED, not senderless. `ON DELETE SET NULL` would have made this null, which
    // reads the same as a message that never had an author — and `toFrame` drops those.
    expect(mine?.user).toBe("deletable");

    // The profile is gone and the user is invisible to the API.
    expect((await profile("deletable")).status).toBe(404);
    // The membership and the read position went with it: the listing 404s the user, so
    // the membership is asserted from the channel's side.
    const remaining = await repo.countMembers(channel.id);
    expect(remaining).toBe(0);
  });

  it("leaves usage_active_users rows alone (FR-029)", async () => {
    // Billing history does not vanish with a profile: a customer who deleted a user in
    // March still owes for March.
    //
    // THE ROW IS WRITTEN BY A SEND, not by a helper. `sendMessage` inserts into
    // `usage_active_users` when the send is attributed — that is the only writer — so the
    // fixture has to send. Read back through `usageFor`, which is the reader the billing
    // surface uses, rather than a raw count this suite may not hold.
    const billed = await repo.createUser("billed", "Billed");
    const channel = await repo.createChannel("billing-witness", "public");
    await repo.addMember(channel.id, billed.id);
    await repo.sendMessage(channel.id, {
      text: "counts toward the month",
      userId: billed.id,
      userExternalId: "billed",
    });
    const before = await usageFor(db, environmentId, periodOf(new Date()));
    expect(before.activeUsers).toBeGreaterThan(0);

    expect((await removeUser("billed")).status).toBe(200);

    const after = await usageFor(db, environmentId, periodOf(new Date()));
    expect(after.activeUsers).toBe(before.activeUsers);
    expect(after.messagesSent).toBe(before.messagesSent);
  });

  it("answers 200 on a second delete and 404 for a user who never existed", async () => {
    const twice = await repo.createUser("twice-deleted", "Twice");
    expect(twice.external_id).toBe("twice-deleted");
    expect((await removeUser("twice-deleted")).status).toBe(200);
    expect((await removeUser("twice-deleted")).status).toBe(200);
    expect((await removeUser("never-existed-at-all")).status).toBe(404);
  });

  // ── T146: the id comes back and the row is reused (FR-030) ──────────────────
  it("reuses the row when the same external id is presented again", async () => {
    const revived = await repo.createUser("revivable", "Before Deletion");
    await patchProfile("revivable", { metadata: { before: true } });
    await removeUser("revivable");
    expect((await profile("revivable")).status).toBe(404);

    const res = await upsert([{ external_id: "revivable" }]);
    const body = (await res.json()) as { data: Array<{ status: string }> };
    expect(body.data[0]!.status).toBe("revived");

    const back = (await (await profile("revivable")).json()) as {
      external_id: string;
      display_name: string | null;
      avatar_url: string | null;
      metadata: Record<string, unknown>;
    };
    // THE SAME ROW, EMPTY. `(environment_id, external_id)` is unique and the row never
    // left, so there is no other honest answer than reusing it — and a revived row does
    // not inherit the profile the deletion wiped.
    expect(back).toEqual({
      external_id: "revivable",
      display_name: null,
      avatar_url: null,
      metadata: {},
    });
    const after = await repo.getUserByExternalId("revivable");
    expect(after?.id).toBe(revived.id);
  });

  // ── T147: deleting a channel's owner ────────────────────────────────────────
  it("deletes a channel owner and leaves the channel ownerless", async () => {
    // FR-CHN-04's roles and FR-USR-05's deletion meet here, and the chapter has to say
    // what happens. MEASURED: the membership row goes, so the channel has no owner and
    // no route can appoint one — `PATCH .../members/:userExternalId` sets the role of an
    // EXISTING member, so a channel whose only owner is deleted cannot get another
    // without somebody being added first.
    //
    // Left as it is, and stated rather than fixed: nothing in the platform reads
    // `members.role` to authorize anything, so an ownerless channel behaves exactly like
    // an owned one. The day a permission consults the column, this becomes a real
    // question — and the answer will be a route, not a cascade.
    const channel = await repo.createChannel("ownerless", "public");
    const owner = await repo.createUser("the-owner", "The Owner");
    const other = await repo.createUser("the-other", "The Other");
    await repo.addMember(channel.id, owner.id, "owner");
    await repo.addMember(channel.id, other.id);
    expect(await repo.memberRole(channel.id, owner.id)).toBe("owner");

    await removeUser("the-owner");

    expect(await repo.memberRole(channel.id, owner.id)).toBeNull();
    expect(await repo.memberRole(channel.id, other.id)).toBe("member");
    // The channel is still there and still usable by its remaining member.
    const still = await fetch(`${url}/v1/channels/${channel.id}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(still.status).toBe(200);
  });

  // ══ THE BAN (chapter 3.15, FR-031, FR-032, SC-013) ══════════════════════════

  const ban = (user: string, key = credential) =>
    fetch(`${url}/v1/users/${user}/ban`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });

  const unban = (user: string, key = credential) =>
    fetch(`${url}/v1/users/${user}/ban`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });

  const sendAs = (channelId: string, token: string, text: string) =>
    fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });

  // ── T152: banned cannot send, history survives, lifting restores ────────────
  it("refuses a banned user's send and restores it when the ban lifts", async () => {
    const channel = await repo.createChannel("ban-witness", "public");
    const speaker = await repo.createUser("bannable", "Bannable");
    await repo.addMember(channel.id, speaker.id);
    const token = await tokenFor("bannable");

    // THE CONTROL FIRST. A refusal proves nothing unless the same call worked a moment
    // ago — chapter 3.12's fourteen green tests are why this line exists.
    expect((await sendAs(channel.id, token, "before the ban")).status).toBe(201);

    expect((await ban("bannable")).status).toBe(200);
    const refused = await sendAs(channel.id, token, "during the ban");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("user_banned");

    // HISTORY IS UNTOUCHED. A ban is not a deletion: their earlier message is still
    // there and still theirs, readable by the tenant.
    const history = await fetch(`${url}/v1/channels/${channel.id}/messages?limit=10`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const messages = (await history.json()) as {
      messages: Array<{ text: string | null; user: string | null }>;
    };
    expect(messages.messages.some((m) => m.text === "before the ban")).toBe(true);
    expect(messages.messages.some((m) => m.text === "during the ban")).toBe(false);

    expect((await unban("bannable")).status).toBe(200);
    expect((await sendAs(channel.id, token, "after the ban")).status).toBe(201);
  });

  it("answers 200 on a repeated ban and a repeated unban", async () => {
    await repo.createUser("twice-banned", "Twice");
    expect((await ban("twice-banned")).status).toBe(200);
    expect((await ban("twice-banned")).status).toBe(200);
    expect((await unban("twice-banned")).status).toBe(200);
    expect((await unban("twice-banned")).status).toBe(200);
  });

  it("answers 404 for a user this tenant does not have, and for a deleted one", async () => {
    expect((await ban("never-heard-of")).status).toBe(404);
    const gone = await repo.createUser("ban-then-delete", "Gone");
    await repo.deleteUser(gone.id);
    // A DELETED USER CANNOT BE BANNED, and does not need to be: every route naming them
    // answers 404 and their session carries no channels. Banning one would be a state
    // with no observable difference.
    expect((await ban("ban-then-delete")).status).toBe(404);
  });

  // ── T154: the two edge cases the spec names ─────────────────────────────────
  it("bans a private channel's member without removing them", async () => {
    // THE BAN IS TENANT-SCOPED, so it is not a removal. The membership survives, the
    // channel still lists them, and lifting the ban restores everything with nobody
    // re-added.
    const priv = await repo.createChannel("ban-private", "private");
    const member2 = await repo.createUser("private-bannable", "Private Bannable");
    await repo.addMember(priv.id, member2.id);
    const token = await tokenFor("private-bannable");
    expect((await sendAs(priv.id, token, "a member speaks")).status).toBe(201);

    await ban("private-bannable");
    const refused = await sendAs(priv.id, token, "still a member, still banned");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("user_banned");
    // Still a member, and the listing still shows the channel.
    expect(await repo.isMember(priv.id, member2.id)).toBe(true);
    const listed = (await (await list("private-bannable", "?limit=100")).json()) as {
      data: Array<{ external_id: string }>;
    };
    expect(listed.data.map((c) => c.external_id)).toContain("ban-private");

    await unban("private-bannable");
    expect((await sendAs(priv.id, token, "and back")).status).toBe(201);
  });

  it("does not let implicit creation undo a ban", async () => {
    // A token minted for a banned user's identifier must not revive them. `createUser`
    // is idempotent and touches no other column, so the row — and the ban on it —
    // survives a mint. The upsert is the route that clears state, and it clears
    // `deleted_at` only.
    const target = await repo.createUser("mint-after-ban", "Minted");
    await ban("mint-after-ban");
    const token = await tokenFor("mint-after-ban");
    expect(token.length).toBeGreaterThan(0);

    const channel = await repo.createChannel("mint-room", "public");
    await repo.addMember(channel.id, target.id);
    const refused = await sendAs(channel.id, token, "minted my way in");
    expect(refused.status).toBe(403);

    // And an upsert naming them does not lift it either: the upsert clears `deleted_at`
    // because FR-030 asks it to, and says nothing about `banned_at`.
    await upsert([{ external_id: "mint-after-ban", display_name: "Renamed" }]);
    expect((await sendAs(channel.id, token, "upserted my way in")).status).toBe(403);
  });
});
