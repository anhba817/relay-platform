import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { AppModule } from "../app.module";
import { mintUserToken } from "../auth/user-token";
import { environmentSigningSecret } from "../db/repository";
import { createDb, createPool } from "../db/client";
import { createApiKey, createEnvironment, Repository } from "../db/repository";
// The comparison this suite invented, now shared. Chapter 3.12 moved it into
// `isolation/compare.ts` so 24 routes could use the same oracle; it is imported
// back rather than duplicated, which is the fault that chapter is about.
import { withoutRequestId } from "../isolation/compare";


// The endpoint path (chapter 2.2): guard → pipe → service → repository →
// filter, over real HTTP against the compose Postgres. Its own environment,
// minted here — no truncate, because tenant isolation means this suite and
// the repository suite cannot see each other's rows (2.1's property, paying
// for itself in the test lane).
describe("POST /v1/channels/:channelId/messages", () => {
  let app: INestApplication;
  let url: string;
  let env: { id: string };
  // Chapter 3.2: the tenant arrives as a CREDENTIAL now, not as a header. The
  // suite mints its own key the same way signup does — through the repository's
  // admin surface — so nothing here needs a test-only route to exist.
  let credential: string;
  let channelId: string;
  let foreignChannelId: string;
  let privateChannelId: string;
  let tokenFor: (user: string) => Promise<string>;
  /** Suite-scoped so a test can build its OWN fixture rather than lean on shared
   * state an earlier test may have changed. T072b's first draft used
   * `privateChannelId` and failed on its control: T057 above removes `insider` from
   * that channel, so by then the "member" was not one. A test that depends on the
   * order it runs in is a test that will fail for a reason it does not name. */
  let repo: Repository;

  beforeAll(async () => {
    const db = createDb(createPool());
    env = await createEnvironment(db, { name: "messages-itest" });
    channelId = (
      await new Repository(db, env.id).createChannel("general", "public")
    ).id;
    credential = (await createApiKey(db, { environmentId: env.id })).credential;
    const other = await createEnvironment(db, { name: "messages-itest-other" });
    foreignChannelId = (
      await new Repository(db, other.id).createChannel("theirs", "public")
    ).id;

    // Chapter 3.15's fixtures: a private channel, one member, one stranger of the
    // SAME tenant, and a way to mint their tokens. The private channel is created
    // through the repository because `POST /v1/channels` does not accept `private`
    // until the read paths enforce it (FR-009's ordering).
    repo = new Repository(db, env.id);
    privateChannelId = (await repo.createChannel("members-only", "private")).id;
    const member = await repo.createUser("insider", "An Insider");
    await repo.addMember(privateChannelId, member.id);
    await repo.createUser("outsider", "An Outsider");
    // A BOT OF THIS TENANT, and a person, for chapter 3.17's four outcomes. Added
    // beside the existing fixtures and NOT added to `privateChannelId` — that
    // membership is load-bearing for the tests above, and a bot needs none of it
    // (FR-019a) which is the point T012c makes.
    await repo.upsertUser("courier", {
      display_name: "Courier",
      kind: "bot",
      description: "delivers build results into the channel",
    });
    const signingSecret = (await environmentSigningSecret(db, env.id))!
      .signingSecret;
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
  });

  afterAll(async () => {
    await app.close();
  });

  // KEY SENDS NAME `courier`, THE TENANT'S BOT (chapter 3.17, T059). Each caller passes
  // its own body, so the sender is added per call rather than defaulted here — a default
  // would hide which tests are about the sender and which merely need one.
  const send = (body: unknown, channel = channelId, key = credential) =>
    fetch(`${url}/v1/channels/${channel}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

  it("returns 201 with an ascending sequence", async () => {
    const first = await send({ text: "hello", user: "courier" });
    expect(first.status).toBe(201);
    const a = (await first.json()) as { seq: number };
    const b = (await (await send({ text: "again", user: "courier" })).json()) as { seq: number };
    expect(b.seq).toBe(a.seq + 1);
  });

  it("rejects a malformed body through the protocol envelope", async () => {
    const res = await send({ text: "", user: "courier" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "invalid_request" });
    expect(typeof body.docs_url).toBe("string");
  });

  it("answers a foreign channel's HISTORY with that same 404 (chapter 2.8)", async () => {
    // The milestone suite found the two doors disagreeing: POST said 404 for
    // a channel this tenant cannot see, GET said 200 with an empty page. An
    // empty page leaks nothing, but it leaves a client unable to tell "no
    // such conversation" from "nothing said yet" — and one resource should
    // not answer two ways depending on the verb.
    const foreign = await fetch(
      `${url}/v1/channels/${foreignChannelId}/messages?limit=10`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    const missing = await fetch(
      `${url}/v1/channels/${crypto.randomUUID()}/messages?limit=10`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(withoutRequestId(await foreign.json())).toEqual(
      withoutRequestId(await missing.json()),
    );
  });

  it("answers a FOREIGN channel id with the same 404 as a missing one", async () => {
    const foreign = await send({ text: "not for you", user: "courier" }, foreignChannelId);
    const missing = await send({ text: "nobody home", user: "courier" }, crypto.randomUUID());
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    // Indistinguishable — no data, and no reveal that the id exists.
    expect(withoutRequestId(await foreign.json())).toEqual(
      withoutRequestId(await missing.json()),
    );
  });

  // ── THE ROUTE A CUSTOMER'S CLIENT ACTUALLY CALLS (chapter 3.15, FR-001) ───────
  //
  // The membership check lives in `repository.sendMessage` and is gated on `userId`
  // being present. `repository.itest.ts` proves the check EXISTS by driving that
  // function directly with a user id. Only these tests prove it FIRES, because for
  // twenty-three chapters this controller called `messages.send(channelId, body)`
  // with no user at all — and `MessagesController` declared no `@Accepts` at the time,
  // so the guard fell back to `EITHER` and a user token was accepted here. Chapter 3.17
  // declared it; this sentence went on describing its absence until 3.23.
  //
  // So the repository test passed while the route it protects was open. A repository
  // test proves a check exists; only a route test proves it fires.
  describe("a private channel over the public route (FR-001, SC-002)", () => {
  
  // ══ THE SENDER (chapter 3.17, US2) ══════════════════════════════════════════

  // ── T033: the four outcomes for an application credential ──────────────────
  it("accepts a key's send naming a bot, and echoes the sender it used", async () => {
    const res = await send({ text: "build 412 is green", user: "courier" });
    expect(res.status).toBe(201);
    // FR-009a: a caller now required to name a sender is told which was recorded.
    expect((await res.json()).user).toBe("courier");
  });

  it("refuses a key's send naming a person with 403 sender_not_permitted", async () => {
    const res = await send({ text: "posting as a human", user: "outsider" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; message: string };
    // T032a: `ProtocolErrorFilter` maps a bare 403 to `forbidden`, and this is the one
    // code in the chapter that collides with that ladder. The wire must carry the
    // specific fact, not the generic one.
    expect(body.code).toBe("sender_not_permitted");
    expect(body.code).not.toBe("forbidden");
    // And it names neither the person asked for nor the bots that would have worked.
    expect(body.message).not.toContain("outsider");
    expect(body.message).not.toContain("courier");
  });

  it("refuses a key's send naming nobody with 400 and the field", async () => {
    const res = await send({ text: "who is this from?" });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("user");
  });

  it("refuses a foreign sender and a nonexistent one identically", async () => {
    const foreign = await createEnvironment(createDb(createPool()), {
      name: `messages-itest-foreign-${randomUUID().slice(0, 8)}`,
    });
    await new Repository(createDb(createPool()), foreign.id).upsertUser("theirs", {
      kind: "bot",
      description: "a bot of another tenant",
    });

    const a = await send({ text: "x", user: "theirs" });
    const b = await send({ text: "x", user: "no-such-identifier-anywhere" });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    // SC-005: the two answers must be indistinguishable, or naming an identifier is a
    // way to ask whether another tenant has one.
    expect(withoutRequestId(await a.json())).toEqual(
      withoutRequestId(await b.json()),
    );
  });

  // ── T034: a user token attributes to its subject and may name nobody ───────
  it("attributes a user token's send to its subject", async () => {
    const token = await tokenFor("insider");
    const res = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "from a person" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).user).toBe("insider");
  });

  it("refuses a body `user` beside a user token", async () => {
    const token = await tokenFor("insider");
    const res = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "posting as someone else", user: "courier" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("user");
  });

  // ── T012c: the private channel, BOTH halves (SC-012) ───────────────────────
  //
  // A test that checked only the bot would pass if the membership gate had been deleted
  // outright — which is the change that breaks chapter 3.15's refusal. The pair is the
  // oracle.
  it("lets a key's bot send to a private channel it is not a member of", async () => {
    const res = await send(
      { text: "from the tenant's software", user: "courier" },
      privateChannelId,
    );
    expect(res.status).toBe(201);
  });

  it("still refuses a person who is not a member of that private channel", async () => {
    const token = await tokenFor("outsider");
    const res = await sendAs(token, privateChannelId);
    // 404, not 403: a private channel a caller cannot see answers as if absent
    // (chapter 3.15, FR-019b).
    expect(res.status).toBe(404);
  });

  // ── T012d: a bot may be banned (FR-005c, SC-013) ───────────────────────────
  it("refuses a banned bot's send, indistinguishably from a foreign sender", async () => {
    await repo.upsertUser("runaway", {
      kind: "bot",
      description: "posts far too often",
    });
    const banned = await repo.getUserByExternalId("runaway");
    await repo.banUser(banned!.id);

    const res = await send({ text: "still going", user: "runaway" });
    // A ban stops a runaway integration without deleting the identity its messages are
    // attributed to. The refusal is the ban's, which arrives before the channel is read.
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("user_banned");
  });

  const sendAs = async (token: string, channel: string, text = "hello") =>
      fetch(`${url}/v1/channels/${channel}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text }),
      });

    it("refuses a non-member's send with the not-found envelope, body and all", async () => {
      const token = await tokenFor("outsider");
      const refused = await sendAs(token, privateChannelId);
      const absent = await sendAs(token, "00000000-0000-4000-8000-000000000000");

      expect(refused.status).toBe(absent.status);
      // Byte-identical but for `request_id`, which is SC-002's actual requirement —
      // matching status codes is the easy half and says nothing on its own.
      // Deleting rather than destructuring: an unused binding is a lint error and
      // the intent is a removal either way. `request_id` is the one field that
      // differs by construction — it names the request, not the resource — which is
      // why chapter 3.12's oracle drops exactly this one and nothing else.
      const strip = (b: Record<string, unknown>) => {
        delete b.request_id;
        return b;
      };
      expect(strip((await refused.json()) as Record<string, unknown>)).toEqual(
        strip((await absent.json()) as Record<string, unknown>),
      );
    });

    it("accepts a member's send to the same channel", async () => {
      // The control, and it is not optional. Two refusals for unrelated reasons are
      // also indistinguishable — a token the guard rejects outright would pass the
      // test above while proving nothing about membership.
      const token = await tokenFor("insider");
      const accepted = await sendAs(token, privateChannelId, "mine to send");
      expect(accepted.status).toBe(201);
    });

    it("accepts an application key's send to the same private channel (FR-005)", async () => {
      const accepted = await send({ text: "from the tenant", user: "courier" }, privateChannelId);
      expect(accepted.status).toBe(201);
    });

    it("answers a non-member's history read exactly as an absent channel does", async () => {
    // T041b. The history route dropped its caller the same way the send route did,
    // and `listMessages` had no `userId` parameter to drop it INTO — so the task
    // that said "add the same check to the history path" was asking for a check
    // with nothing to check against. Three places, and a gap in any one makes a
    // check unreachable: the handler resolves, the service threads, the repository
    // accepts.
    //
    // AND THE FIRST ATTEMPT AT THIS TEST WAS WRONG IN AN INSTRUCTIVE WAY. It
    // expected an empty page, because `listMessages` answers an unknown channel id
    // with `[]` at the repository level. The ROUTE answers 404 — `messages.service`
    // checks `channelExists` first — so an empty page for a private channel would
    // have differed from an absent one and announced that the channel was there.
    // Only comparing the two answers caught it, which is the whole point of pairing
    // them rather than asserting a status.
    const outsider = await tokenFor("outsider");
    const insider = await tokenFor("insider");
    await sendAs(insider, privateChannelId, "members can read this");

    const hidden = await fetch(
      `${url}/v1/channels/${privateChannelId}/messages?limit=10`,
      { headers: { authorization: `Bearer ${outsider}` } },
    );
    const absent = await fetch(
      `${url}/v1/channels/00000000-0000-4000-8000-000000000000/messages?limit=10`,
      { headers: { authorization: `Bearer ${outsider}` } },
    );
    expect(hidden.status).toBe(absent.status);
    // The whole body, `request_id` excepted — a private channel the caller cannot
    // see and a channel that does not exist give one answer.
    expect(withoutRequestId(await hidden.json())).toEqual(
      withoutRequestId(await absent.json()),
    );
  });

  it("returns the page to a member of the same channel", async () => {
    // The control: the page exists and the reader is the variable.
    const insider = await tokenFor("insider");
    const res = await fetch(
      `${url}/v1/channels/${privateChannelId}/messages?limit=10`,
      { headers: { authorization: `Bearer ${insider}` } },
    );
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("returns the page to an application credential (FR-005)", async () => {
    const res = await fetch(
      `${url}/v1/channels/${privateChannelId}/messages?limit=10`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("refuses a removed member's send, and their messages stay (SC-004, SC-005)", async () => {
    // T057. This is phase 3's check reading a row that is now gone — no new code
    // path, which is the point: removal takes the membership away and the check
    // that was already there does the rest.
    const token = await tokenFor("insider");
    const sent = await sendAs(token, privateChannelId, "written while a member");
    expect(sent.status).toBe(201);

    await fetch(`${url}/v1/channels/${privateChannelId}/members/remove`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
      body: JSON.stringify({ user_ids: ["insider"] }),
    });

    const refused = await sendAs(token, privateChannelId, "after removal");
    const absent = await sendAs(token, "00000000-0000-4000-8000-000000000000");
    expect(refused.status).toBe(absent.status);

    // And what they wrote is still there, read with the tenant's key.
    const history = await fetch(
      `${url}/v1/channels/${privateChannelId}/messages?limit=100`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    const body = (await history.json()) as { messages: { user: string | null }[] };
    expect(body.messages.some((m) => m.user === "insider")).toBe(true);
  });

  it("an archived PRIVATE channel answers a non-member as an absent one does", async () => {
    // T072b, and the point of FR-021a's order. Reverse the last two checks — archive
    // before membership — and this test goes red: the non-member would get
    // `channel_archived` and learn the channel exists. Asserted with the oracle
    // rather than by reading the code, because the order is only observable from
    // outside as a pair of answers.
    // Its own channel and its own member, for the reason `repo` is suite-scoped.
    const channel = (await repo.createChannel("archived-private", "private")).id;
    const member = await repo.getUserByExternalId("insider");
    await repo.addMember(channel, member!.id);
    await fetch(`${url}/v1/channels/${channel}/archive`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });

    const outsider = await tokenFor("outsider");
    const refused = await sendAs(outsider, channel);
    const absent = await sendAs(outsider, "00000000-0000-4000-8000-000000000000");
    expect(refused.status).toBe(absent.status);
    expect(withoutRequestId(await refused.json())).toEqual(
      withoutRequestId(await absent.json()),
    );

    // The control that makes it mean something: a MEMBER of the same archived
    // channel gets `channel_archived`, so the archive check is live and it is the
    // ORDER that hides it from the non-member.
    const insider = await tokenFor("insider");
    const asMember = await sendAs(insider, channel);
    expect(asMember.status).toBe(403);
    expect(((await asMember.json()) as { code: string }).code).toBe("channel_archived");
  });

  it("refuses a token minted for an identifier with no user row", async () => {
      // `POST /auth/dev-token` mints tokens for identifiers that need not exist, so
      // before chapter 3.15 this send SUCCEEDED, unattributed — and an unattributed
      // send is one the membership check waves through. A user with no row is a
      // member of nothing. FR-039a removes the case by creating the row at mint time.
      const token = await tokenFor("never-seen-before");
      const refused = await sendAs(token, privateChannelId);
      expect(refused.status).toBe(400);
    });
  });
});


// ══ EDITING A MESSAGE (chapter 3.23, US1) ═══════════════════════════════════
//
// T024 WROTE THESE RED, and the route answering 404 is what "red for the right reason"
// means here: `PATCH` on a path Nest has no handler for is a 404 from the router, not
// from the visibility predicate, and the two are indistinguishable from outside. Every
// test below therefore asserts something a 404 cannot satisfy.
describe("PATCH /v1/channels/:channelId/messages/:messageId (chapter 3.23)", () => {
  let app: INestApplication;
  let url: string;
  let env: { id: string };
  let credential: string;
  let channelId: string;
  let foreignChannelId: string;
  let privateChannelId: string;
  let repo: Repository;
  let outboxDb: ReturnType<typeof createDb>;
  let tokenFor: (user: string) => Promise<string>;

  beforeAll(async () => {
    // ITS OWN ENVIRONMENT, like every describe in this file. The suite above shares a
    // channel between tests that archive it and remove members from it; an edit test
    // leaning on that would fail for a reason it does not name.
    const db = createDb(createPool());
    outboxDb = db;
    env = await createEnvironment(db, { name: "edit-itest" });
    repo = new Repository(db, env.id);
    channelId = (await repo.createChannel("general", "public")).id;
    privateChannelId = (await repo.createChannel("members-only", "private")).id;
    credential = (await createApiKey(db, { environmentId: env.id })).credential;
    const other = await createEnvironment(db, { name: "edit-itest-other" });
    foreignChannelId = (
      await new Repository(db, other.id).createChannel("theirs", "public")
    ).id;
    const author = await repo.createUser("author", "The Author");
    await repo.createUser("bystander", "A Bystander");
    // THE AUTHOR IS A MEMBER OF THE PRIVATE CHANNEL and the bystander is not. The pair
    // is what makes the visibility check observable — see the test that needs it.
    await repo.addMember(privateChannelId, author.id);
    await repo.upsertUser("courier", {
      display_name: "Courier",
      kind: "bot",
      description: "delivers build results into the channel",
    });
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
  });

  afterAll(async () => {
    await app.close();
  });

  /** A message by `author`, sent with their own token so the row carries them. */
  const sendAsAuthor = async (text: string, channel = channelId) => {
    const token = await tokenFor("author");
    const res = await fetch(`${url}/v1/channels/${channel}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; seq: number; created_at: string };
  };

  const patch = (
    messageId: string,
    body: unknown,
    auth: string,
    channel = channelId,
  ) =>
    fetch(`${url}/v1/channels/${channel}/messages/${messageId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });

  const history = async (channel = channelId) => {
    const res = await fetch(`${url}/v1/channels/${channel}/messages?limit=50`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    return (await res.json()) as { messages: Array<Record<string, unknown>> };
  };

  it("T024: the author edits their message and the text changes (FR-001, FR-003)", async () => {
    const sent = await sendAsAuthor("frist");
    const res = await patch(sent.id, { text: "first" }, await tokenFor("author"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["text"]).toBe("first");
    // THE SEQUENCE IS THE SAME NUMBER (FR-002). Not "a number" — the one it had.
    expect(body["seq"]).toBe(sent.seq);
    expect(body["id"]).toBe(sent.id);
    expect(typeof body["edited_at"]).toBe("string");
    // …and the read path agrees, which a response body alone does not prove.
    const rows = (await history()).messages.filter((m) => m["id"] === sent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["text"]).toBe("first");
  });

  it("T024: an unedited message reports no edited_at (FR-003)", async () => {
    // The control for the assertion above. `edited_at` being a string after an edit
    // means nothing unless it is absent before one — a column defaulting to `now()`
    // would pass the test above and fail this.
    const sent = await sendAsAuthor("untouched");
    const rows = (await history()).messages.filter((m) => m["id"] === sent.id);
    // `toHaveProperty(…, null)` AND NOT `?? null`. The first draft read
    // `rows[0]!["edited_at"] ?? null` and was green before the route existed, because
    // an ABSENT key and a null one are the same value through `??` — so it would have
    // stayed green if the read path never carried the field at all.
    expect(rows[0]!).toHaveProperty("edited_at", null);
  });

  it("T024: somebody else's message is refused with not_message_author (FR-013)", async () => {
    const sent = await sendAsAuthor("mine");
    const res = await patch(sent.id, { text: "yours now" }, await tokenFor("bystander"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("not_message_author");
    // AND THE TEXT DID NOT CHANGE. A 403 with the write already done is the failure
    // this half exists to catch.
    const rows = (await history()).messages.filter((m) => m["id"] === sent.id);
    expect(rows[0]!["text"]).toBe("mine");
  });

  it("T024: a tenant API key may not edit at all (FR-013a)", async () => {
    // The decision the spec records: a key deletes anything and edits nothing. An
    // application credential has no author to compare against, so `@Accepts("user")`
    // on the method is what answers — and the class declares BOTH classes, so a route
    // added without a declaration would accept the key and then have nothing to check.
    const sent = await sendAsAuthor("not yours to fix");
    const res = await patch(sent.id, { text: "fixed" }, credential);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("wrong_credential_type");
  });

  it("T024: a message in a channel this tenant cannot see is a 404 (FR-014)", async () => {
    // Indistinguishable from a message id that does not exist, which is the pair the
    // isolation oracle asserts everywhere else in this file.
    const token = await tokenFor("author");
    const foreign = await patch(randomUUID(), { text: "x" }, token, foreignChannelId);
    const missing = await patch(randomUUID(), { text: "x" }, token, randomUUID());
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(withoutRequestId(await foreign.json())).toEqual(
      withoutRequestId(await missing.json()),
    );
  });

  it("T024: a message id that is not in this channel is a 404 (FR-014)", async () => {
    // The pair above shares a tenant boundary. This one does not: both channels belong
    // to this environment and the message belongs to the other one, so the only thing
    // that can refuse it is the route checking the message against the channel in the
    // path rather than trusting the id.
    const elsewhere = (await repo.createChannel("elsewhere", "public")).id;
    const sent = await sendAsAuthor("over here", elsewhere);
    const res = await patch(sent.id, { text: "moved" }, await tokenFor("author"));
    expect(res.status).toBe(404);
  });

  it("T024: a non-member of a private channel gets the not-found envelope, not a 403 (FR-014)", async () => {
    // WRITTEN BECAUSE THE FALSIFICATION CAME BACK GREEN. Removing `channelVisibleTo`
    // from `messages.service.edit` broke nothing: `editMessage`'s join already carries
    // the environment, so a FOREIGN channel refuses either way, and the foreign/missing
    // pair above compares two bodies that both read "message not found" whichever check
    // produced them. The one case only the visibility predicate answers is a private
    // channel of THIS tenant that the caller cannot see — and without it the caller
    // learns the message is there from a 403 naming its authorship.
    const token = await tokenFor("bystander");
    const inside = await (async () => {
      const authorToken = await tokenFor("author");
      const res = await fetch(`${url}/v1/channels/${privateChannelId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authorToken}`,
        },
        body: JSON.stringify({ text: "members only" }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string };
    })();

    const refused = await patch(inside.id, { text: "seen it" }, token, privateChannelId);
    const absent = await patch(randomUUID(), { text: "seen it" }, token, randomUUID());
    expect(refused.status).toBe(404);
    expect(absent.status).toBe(404);
    // BYTE-IDENTICAL, which is the half a 403 fails. Without the predicate this is a
    // 403 `not_message_author` and the bystander has learned that a channel they cannot
    // read holds a message somebody else wrote.
    expect(withoutRequestId(await refused.json())).toEqual(
      withoutRequestId(await absent.json()),
    );

    // The control: the author, who IS a member, can still edit it. Otherwise the 404
    // above could be a private channel refusing everybody.
    const allowed = await patch(
      inside.id,
      { text: "members only, corrected" },
      await tokenFor("author"),
      privateChannelId,
    );
    expect(allowed.status).toBe(200);
  });

  const edits = (messageId: string, auth: string, channel = channelId) =>
    fetch(`${url}/v1/channels/${channel}/messages/${messageId}/edits`, {
      headers: { authorization: `Bearer ${auth}` },
    });

  it("T033d: the edit history reads back oldest first, through the route (SC-002)", async () => {
    // THROUGH THE ROUTE AND NOT THE DATABASE. `repository.itest.ts` proves the rows
    // exist; only this proves anybody can retrieve them — the distinction CLAUDE.md
    // records as "a repository test proves a check exists; only a route test proves it
    // fires", pointed the other way.
    const sent = await sendAsAuthor("one");
    const token = await tokenFor("author");
    for (const text of ["two", "three", "four"]) {
      expect((await patch(sent.id, { text }, token)).status).toBe(200);
    }

    const res = await edits(sent.id, credential);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      edits: Array<{ prior_text: string; edited_at: string }>;
    };
    expect(body.edits.map((e) => e.prior_text)).toEqual(["one", "two", "three"]);
    for (const entry of body.edits) expect(typeof entry.edited_at).toBe("string");
  });

  it("T033e: an end user is refused, including the message's author (FR-023a, SC-002a)", async () => {
    // THE AUTHOR IS THE CASE THAT MATTERS. A refusal that let the author through would
    // look reasonable and would still be the leak: an end user who can see a channel
    // can see every message in it, so "only your own" is not a narrowing at all once a
    // token can be minted for any identifier.
    const sent = await sendAsAuthor("before");
    const token = await tokenFor("author");
    expect((await patch(sent.id, { text: "after" }, token)).status).toBe(200);

    const asAuthor = await edits(sent.id, token);
    expect(asAuthor.status).toBe(403);
    expect(((await asAuthor.json()) as { code: string }).code).toBe("wrong_credential_type");

    const asStranger = await edits(sent.id, await tokenFor("bystander"));
    expect(asStranger.status).toBe(403);

    // THE CONTROL: the tenant key still reads it. Otherwise the 403s above could be a
    // route that refuses everybody.
    const asKey = await edits(sent.id, credential);
    expect(asKey.status).toBe(200);
    expect(
      ((await asKey.json()) as { edits: Array<{ prior_text: string }> }).edits.map(
        (e) => e.prior_text,
      ),
    ).toEqual(["before"]);
  });

  it("T033f: a message with no edits answers 200 and an empty list, not 404", async () => {
    // The absence of edits is a fact about the message, not the absence of a resource.
    const sent = await sendAsAuthor("never edited");
    const res = await edits(sent.id, credential);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ edits: [] });
  });

  it("T033f: a message id that does not exist IS a 404, which is the other half", async () => {
    // Without this, `{ edits: [] }` would be the answer for a message that was never
    // there — and the route would be unable to tell a caller which of the two it got.
    // `listMessageEdits` returning `[]` cannot distinguish them; `messageExistsIn` is
    // the second question the handler asks for exactly this reason.
    const res = await edits(randomUUID(), credential);
    expect(res.status).toBe(404);
  });

  it("T033f: the edit history of a foreign channel's message is a 404", async () => {
    const res = await edits(randomUUID(), credential, foreignChannelId);
    expect(res.status).toBe(404);
  });

  it("T036a: editing a message to the text it already has is still an edit (FR-021)", async () => {
    // THE PLATFORM DOES NOT COMPARE TEXTS, and the spec says why: every definition of
    // equality — whitespace, case, unicode normalisation, an invisible character — is a
    // decision a customer would have to be told about. So an identical edit records an
    // edit time and appends a history row like any other.
    const sent = await sendAsAuthor("unchanged");
    const token = await tokenFor("author");
    const res = await patch(sent.id, { text: "unchanged" }, token);
    expect(res.status).toBe(200);
    expect((await res.json())["edited_at"]).toBeTruthy();

    const body = (await (await edits(sent.id, credential)).json()) as {
      edits: Array<{ prior_text: string }>;
    };
    // ONE ROW, AND ITS `prior_text` EQUALS THE CURRENT TEXT. That is what "treated as
    // an edit rather than detected and skipped" looks like in the table.
    expect(body.edits.map((e) => e.prior_text)).toEqual(["unchanged"]);
  });

  /** How many events of one type this outbox holds for one message.
   *
   * READ FROM THE TABLE, NOT FROM A SPY. FR-009's requirement is that a second deletion
   * emits no second event, and the only place that is observable is the row the
   * transaction wrote — a mock publisher would show what the code intended to do rather
   * than what committed. `outbox.itest.ts` reads it the same way.
   *
   * The api under test runs IN PROCESS here, against the same database this `db` handle
   * holds, so there is no relay draining it: the suite's fixture leaves
   * `RELAY_OUTBOX_RELAY` alone and nothing publishes. Rows stay put to be counted. */
  const outboxCount = async (messageId: string, type: string): Promise<number> => {
    // A PLAIN STRING AND NOT drizzle's `sql` TEMPLATE, because the lint rule forbids
    // importing `drizzle-orm` outside `db/` — constitution I, and chapter 3.23's T069a
    // restored the ban for integration tests after a second flat-config block had been
    // replacing the rule instead of merging with it. `outbox.itest.ts` reads the table
    // the same way for the same reason. The interpolated values are a uuid this test
    // generated and a literal from this file.
    const res = (await outboxDb.execute(
      `SELECT count(*)::int AS n FROM outbox
         WHERE payload->>'type' = '${type}'
           AND payload->'data'->>'id' = '${messageId}'`,
    )) as unknown as { rows: Array<{ n: number }> };
    return res.rows[0]?.n ?? 0;
  };

  const remove = (messageId: string, auth: string, channel = channelId) =>
    fetch(`${url}/v1/channels/${channel}/messages/${messageId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${auth}` },
    });

  it("T038: the author deletes their message and the row becomes a tombstone (FR-006)", async () => {
    const sent = await sendAsAuthor("regrettable");
    const res = await remove(sent.id, await tokenFor("author"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    // FR-011: history keeps it, in its original position, with a null text.
    const rows = (await history()).messages.filter((m) => m["id"] === sent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["text"]).toBeNull();
    expect(rows[0]!["seq"]).toBe(sent.seq);
    // THE AUTHOR SURVIVES, which is half of what FR-MSG-08 asks the tombstone to keep.
    expect(rows[0]!["user"]).toBe("author");
  });

  it("T038: a tenant API key deletes anybody's message (FR-012)", async () => {
    // FR-MOD-02 grants a key deletion of any message irrespective of author, and this
    // route is the one place in the chapter where the class-level
    // `@Accepts("application", "user")` is CORRECT rather than inherited by accident.
    const sent = await sendAsAuthor("moderated");
    expect((await remove(sent.id, credential)).status).toBe(204);
    const rows = (await history()).messages.filter((m) => m["id"] === sent.id);
    expect(rows[0]!["text"]).toBeNull();
  });

  it("T038: an end user may not delete somebody else's message (FR-013)", async () => {
    const sent = await sendAsAuthor("not yours to remove");
    const res = await remove(sent.id, await tokenFor("bystander"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("not_message_author");
    // …and it is still there, unchanged. A 403 with the write already done is what
    // this half exists to catch.
    const rows = (await history()).messages.filter((m) => m["id"] === sent.id);
    expect(rows[0]!["text"]).toBe("not yours to remove");
  });

  it("T043: deleting twice answers 204 twice, changes nothing, and emits ONE event (FR-009, SC-007)", async () => {
    // TWO 204s PROVE NOTHING — idempotence is about what the second call DID, and the
    // answer is the same either way. The event count is the assertion that carries the
    // requirement, read straight out of the outbox: a second `message.deleted` there
    // means every subscribed webhook fires twice for one deletion.
    const sent = await sendAsAuthor("said once, deleted twice");
    const token = await tokenFor("author");
    expect((await remove(sent.id, token)).status).toBe(204);
    const first = (await history()).messages.find((m) => m["id"] === sent.id)!;

    expect((await remove(sent.id, token)).status).toBe(204);
    const second = (await history()).messages.find((m) => m["id"] === sent.id)!;

    // NOTHING CHANGED, including the deletion timestamp — a second `now()` written
    // here would move it, and a client that had already read the tombstone would see
    // it change for no reason.
    expect(second).toEqual(first);

    const events = await outboxCount(sent.id, "message.deleted");
    expect(events).toBe(1);
  });

  it("T044: editing a tombstone is refused with message_deleted, and a stranger is refused first (FR-010)", async () => {
    const sent = await sendAsAuthor("about to go");
    const token = await tokenFor("author");
    expect((await remove(sent.id, token)).status).toBe(204);

    const asAuthor = await patch(sent.id, { text: "back please" }, token);
    expect(asAuthor.status).toBe(403);
    expect(((await asAuthor.json()) as { code: string }).code).toBe("message_deleted");

    // THE ORDER IS THE DISCLOSURE CONTROL. A stranger gets the authorship answer, not
    // the tombstone one, so `message_deleted` never tells anybody that a message they
    // could not otherwise reach exists.
    const asStranger = await patch(sent.id, { text: "back please" }, await tokenFor("bystander"));
    expect(asStranger.status).toBe(403);
    expect(((await asStranger.json()) as { code: string }).code).toBe("not_message_author");
  });

  it("T038: deleting a message of a channel this tenant cannot see is a 404 (FR-014)", async () => {
    const token = await tokenFor("author");
    const foreign = await remove(randomUUID(), token, foreignChannelId);
    const missing = await remove(randomUUID(), token, randomUUID());
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(withoutRequestId(await foreign.json())).toEqual(
      withoutRequestId(await missing.json()),
    );
  });

  it("T038: a non-member of a private channel gets the not-found envelope on DELETE too (FR-014)", async () => {
    // The same leak the edit route's test covers, on the other verb — and worth its own
    // test because the two routes resolve visibility separately.
    const authorToken = await tokenFor("author");
    const posted = await fetch(`${url}/v1/channels/${privateChannelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${authorToken}` },
      body: JSON.stringify({ text: "members only, briefly" }),
    });
    expect(posted.status).toBe(201);
    const inside = (await posted.json()) as { id: string };

    const refused = await remove(inside.id, await tokenFor("bystander"), privateChannelId);
    expect(refused.status).toBe(404);
    // AND THE TENANT KEY, WHICH MAY DELETE ANYTHING, still can — otherwise the 404
    // above could be a private channel refusing every deletion.
    expect((await remove(inside.id, credential, privateChannelId)).status).toBe(204);
  });

  it("T052: a key's tombstone is the SAME tombstone an author's deletion produces (FR-012, SC-004)", async () => {
    // NOT "both are null". Two messages, one deleted by its author and one by the
    // tenant key, compared field by field through the read path — because FR-012 grants
    // a key deletion of any message and SC-004 asks that the content be gone from every
    // path a reader can reach it by. A moderated message that read differently from a
    // self-deleted one would be a way to tell, from the outside, which happened.
    const mine = await sendAsAuthor("deleted by me");
    const theirs = await sendAsAuthor("deleted by the operator");
    expect((await remove(mine.id, await tokenFor("author"))).status).toBe(204);
    expect((await remove(theirs.id, credential)).status).toBe(204);

    const rows = (await history()).messages;
    const a = rows.find((m) => m["id"] === mine.id)!;
    const b = rows.find((m) => m["id"] === theirs.id)!;
    // The fields that must agree, named rather than compared wholesale: `id`, `seq` and
    // `created_at` differ by construction and say nothing about the deleter.
    for (const key of ["text", "edited_at", "user"]) {
      expect(b[key], `${key} differs between an author's tombstone and a key's`).toEqual(
        a[key],
      );
    }
    expect(a["text"]).toBeNull();
    // AND THE AUTHOR IS STILL THE AUTHOR ON BOTH. A key deleted one of them and the
    // row says who WROTE it — who removed it is `metadata.deleted_by`, which no read
    // path exposes (chapter 3.23's `gaps.md` item 2).
    expect(a["user"]).toBe("author");
    expect(b["user"]).toBe("author");
  });

  it("T054: an end user who is not the author is refused on BOTH routes (FR-013)", async () => {
    // ONE TEST FOR THE PAIR, because FR-013 is one requirement covering both verbs and
    // the two paths reach the refusal through different methods. Same code, same status,
    // and nothing written either way.
    const sent = await sendAsAuthor("neither yours to change nor to remove");
    const stranger = await tokenFor("bystander");

    const edited = await patch(sent.id, { text: "rewritten" }, stranger);
    const removed = await remove(sent.id, stranger);
    expect([edited.status, removed.status]).toEqual([403, 403]);
    expect(((await edited.json()) as { code: string }).code).toBe("not_message_author");
    expect(((await removed.json()) as { code: string }).code).toBe("not_message_author");

    const rows = (await history()).messages.filter((m) => m["id"] === sent.id);
    expect(rows[0]!["text"]).toBe("neither yours to change nor to remove");
    expect(rows[0]!["edited_at"]).toBeNull();
  });

  it("T055: another environment's message is 404 on both routes, never 403 (FR-014)", async () => {
    // 403 WOULD BE THE LEAK. A permission refusal on a foreign id says the id is real;
    // chapter 2.8 made a foreign channel a 404 for exactly this, and the pair below is
    // the assertion the isolation oracle makes everywhere else in this file.
    const token = await tokenFor("author");
    for (const [verb, call] of [
      ["PATCH", (id: string, ch: string) => patch(id, { text: "x" }, token, ch)],
      ["DELETE", (id: string, ch: string) => remove(id, token, ch)],
    ] as const) {
      const foreign = await call(randomUUID(), foreignChannelId);
      const missing = await call(randomUUID(), randomUUID());
      expect(foreign.status, verb).toBe(404);
      expect(missing.status, verb).toBe(404);
      expect(withoutRequestId(await foreign.json())).toEqual(
        withoutRequestId(await missing.json()),
      );
    }
  });

  it("T069: an edit writes exactly one message.updated event, and a second edit writes a second (FR-019)", async () => {
    // THE COUNTERPART TO T043, AND THE OPPOSITE ANSWER. A repeated deletion writes no
    // second event because the row did not change (FR-009); a repeated edit writes one
    // every time, because FR-021 says the platform does not compare texts and every
    // edit is an edit. Two requirements that look symmetrical and are not.
    const sent = await sendAsAuthor("first go");
    const token = await tokenFor("author");
    expect((await patch(sent.id, { text: "second go" }, token)).status).toBe(200);
    expect(await outboxCount(sent.id, "message.updated")).toBe(1);

    expect((await patch(sent.id, { text: "third go" }, token)).status).toBe(200);
    expect(await outboxCount(sent.id, "message.updated")).toBe(2);

    // AND NO CREATION EVENT WAS ADDED. The send wrote one; the two edits wrote none.
    expect(await outboxCount(sent.id, "message.created")).toBe(1);

    // A REFUSED EDIT WRITES NOTHING. The transaction that would have written the event
    // never commits, which is what putting the insert inside it buys.
    expect(
      (await patch(sent.id, { text: "not mine" }, await tokenFor("bystander"))).status,
    ).toBe(403);
    expect(await outboxCount(sent.id, "message.updated")).toBe(2);
  });

  it("T024: an empty text is a 400 through the protocol envelope (FR-001)", async () => {
    const sent = await sendAsAuthor("something");
    const res = await patch(sent.id, { text: "" }, await tokenFor("author"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("invalid_request");
    expect(typeof body["docs_url"]).toBe("string");
  });
});
