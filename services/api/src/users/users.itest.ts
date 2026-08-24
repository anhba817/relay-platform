import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { createApiKey, createEnvironment, Repository } from "../db/repository";

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
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("moves a channel to the front when it takes a message", async () => {
    await repo.sendMessage(oldest, { text: "back from the dead", userId: member.id });
    const body = (await (await list("lister")).json()) as {
      data: Array<{ id: string }>;
    };
    expect(body.data.map((c) => c.id)).toEqual(["oldest", "newest", "middle"]);
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
      data: Array<{ id: string; last_activity_at: string }>;
    };
    const stamps = new Map(before.data.map((c) => [c.id, c.last_activity_at]));

    // Two writes to these rows, neither of them a message.
    const joiner = await repo.createUser("joiner", "A Joiner");
    await repo.addMember(middle, joiner.id);
    await repo.archiveChannel(newest);

    const after = (await (await list("lister")).json()) as {
      data: Array<{ id: string; last_activity_at: string }>;
    };
    for (const c of after.data) {
      expect(c.last_activity_at, `${c.id} moved`).toBe(stamps.get(c.id));
    }
    // And the order is the order it was.
    expect(after.data.map((c) => c.id)).toEqual(before.data.map((c) => c.id));
    await repo.unarchiveChannel(newest);
  });

  // ── T114: membership is the listing set (FR-015) ─────────────────────────────
  it("omits a private channel the user is not a member of", async () => {
    const body = (await (await list("lister")).json()) as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).not.toContain("private-elsewhere");
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

    const body = (await (await list("lister")).json()) as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).not.toContain("public-elsewhere");
  });

  // ── T115: an archived channel appears, with a flag (FR-022) ──────────────────
  it("lists an archived channel and says it is archived", async () => {
    await repo.archiveChannel(middle);
    const body = (await (await list("lister")).json()) as {
      data: Array<{ id: string; archived_at: string | null }>;
    };
    const row = body.data.find((c) => c.id === "middle");
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
      data: Array<{ id: string; role: string }>;
    };
    expect(body.data.find((c) => c.id === "newest")?.role).toBe("moderator");
    expect(body.data.find((c) => c.id === "oldest")?.role).toBe("member");
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
        data: Array<{ id: string }>;
        next_cursor: string | null;
      };
      seen.push(...body.data.map((c) => c.id));
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
});
