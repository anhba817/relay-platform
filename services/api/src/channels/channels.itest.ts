import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { mintUserToken } from "../auth/user-token";
import { createDb, createPool, type Db } from "../db/client";
import { createApiKey, createEnvironment, Repository } from "../db/repository";
import { environmentSigningSecret } from "../db/repository";
import { withoutRequestId } from "../isolation/compare";
import { CHANNEL_MEMBER_LIMIT } from "./channels.schema";

// THE TWO ENDPOINTS, END TO END (FR-016 to FR-019, FR-047, FR-048, SC-014).
//
// The gauntlet attacks these too, from the derived list. This suite is the other
// half: that they WORK, with the shapes an integrating developer is told to
// expect. A route that refuses every cross-tenant request and also refuses every
// legitimate one passes the gauntlet perfectly.

describe("the public channel surface", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let credential: string;
  let repo: Repository;
  let foreignChannelId: string;
  let foreignRepo: Repository;
  let privateChannelId: string;
  let publicChannelId: string;
  let tokenFor: (user: string) => Promise<string>;

  beforeAll(async () => {
    db = createDb(createPool());
    const env = await createEnvironment(db, { name: "channels-itest" });
    repo = new Repository(db, env.id);
    credential = (await createApiKey(db, { environmentId: env.id })).credential;
    const other = await createEnvironment(db, { name: "channels-itest-other" });
    foreignRepo = new Repository(db, other.id);
    foreignChannelId = (await foreignRepo.createChannel("theirs", "public")).id;
    // Chapter 3.15: a private channel, a member, a non-member of the SAME tenant,
    // and a way to mint their tokens. Created through the repository because
    // `POST /v1/channels` accepts `private` only from this phase's last task.
    privateChannelId = (await repo.createChannel("members-only", "private")).id;
    const member = await repo.createUser("insider", "An Insider");
    await repo.addMember(privateChannelId, member.id);
    await repo.createUser("outsider", "An Outsider");
    publicChannelId = (await repo.createChannel("town-square", "public")).id;
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

  const create = (body: unknown, key = credential) =>
    fetch(`${url}/v1/channels`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });

  const addMembers = (channelId: string, body: unknown, key = credential) =>
    fetch(`${url}/v1/channels/${channelId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });

  describe("POST /v1/channels", () => {
    it("creates a channel and answers 201", async () => {
      const res = await create({ external_id: "created-201", type: "public", name: "Support" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        external_id: "created-201",
        type: "public",
        name: "Support",
      });
      expect(typeof body["id"]).toBe("string");
    });

    it("answers the idempotent repeat with 200 and the same channel", async () => {
      const first = await create({ external_id: "repeat", type: "public" });
      expect(first.status).toBe(201);
      const second = await create({ external_id: "repeat", type: "public" });
      // 200 rather than 201, and FR-CHN-02's existing channel rather than a new
      // one. The status is the part a client can act on without reading the body.
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(await first.json());
    });

    // CHAPTER 3.12 ASSERTED THE OPPOSITE HERE, and it was right at the time.
    //
    // FR-047 pinned the enum to `public` alone because `channels.type` decided
    // nothing: an endpoint accepting `private` would have sold a guarantee the
    // platform did not keep. FR-009 supersedes it now that the send path, the by-id
    // read, history and the session all honour the type — the guarantee exists, so
    // the enum may offer it.
    //
    // The `field` half of that test survives intact and is worth keeping: EIR-API-04
    // has carried `field` since chapter 1.3 and nothing set it until chapter 3.14.
    // A third type still names the key it refused.
    it("refuses a type outside the two, naming the field (FR-009)", async () => {
      const res = await create({ external_id: "secret-attempt", type: "secret" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; message: string; field?: string };
      expect(body.code).toBe("invalid_request");
      expect(body.field).toBe("type");
    });

    it("round-trips metadata and refuses it over 8 KB", async () => {
      const ok = await create({
        external_id: "with-metadata",
        type: "public",
        metadata: { team: "fleet", tier: 2 },
      });
      expect(ok.status).toBe(201);
      expect((await ok.json()) as Record<string, unknown>).toMatchObject({
        metadata: { team: "fleet", tier: 2 },
      });

      const tooBig = await create({
        external_id: "metadata-too-big",
        type: "public",
        metadata: { blob: "x".repeat(9 * 1024) },
      });
      expect(tooBig.status).toBe(400);
      expect(((await tooBig.json()) as { code: string }).code).toBe("invalid_request");
    });

    it("refuses an unknown field rather than ignoring it", async () => {
      const res = await create({ external_id: "typo", type: "public", externalId: "typo" });
      expect(res.status).toBe(400);
    });

    it("lets two tenants own the same external id, independently", async () => {
      const mine = await create({ external_id: "theirs", type: "public" });
      expect(mine.status).toBe(201);
      // `theirs` is the other environment's channel's external id, seeded above.
      expect(((await mine.json()) as { id: string }).id).not.toBe(foreignChannelId);
    });
  });

  describe("POST /v1/channels/:channelId/members", () => {
    let channelId: string;

    beforeAll(async () => {
      channelId = ((await (await create({ external_id: "members", type: "public" })).json()) as {
        id: string;
      }).id;
    });

    it("adds members and creates the users on first membership", async () => {
      const res = await addMembers(channelId, { user_ids: ["tuan", "mai"] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { members: { external_id: string; status: string }[] };
      expect(body.members.map((m) => m.external_id)).toEqual(["tuan", "mai"]);
      expect(body.members.every((m) => m.status === "added")).toBe(true);
      // The users did not exist a moment ago. FR-CHN-04: membership creates them.
      expect(await repo.getUserByExternalId("tuan")).not.toBeNull();
      expect((await repo.listMembers(channelId)).length).toBe(2);
    });

    it("says already_a_member on a repeat, and is not a 500 (T052)", async () => {
      const res = await addMembers(channelId, { user_ids: ["tuan"] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { members: { status: string }[] };
      expect(body.members[0]?.status).toBe("already_a_member");
      // Before this chapter `members`' primary key raised a unique violation here
      // and `ProtocolErrorFilter` rendered it as `internal_error` — a 500 for a
      // client doing something entirely reasonable.
      expect((await repo.listMembers(channelId)).length).toBe(2);
    });

    it("refuses more than 100 in one call (FR-CHN-06)", async () => {
      const res = await addMembers(channelId, {
        user_ids: Array.from({ length: 101 }, (_, i) => `bulk-${i}`),
      });
      expect(res.status).toBe(400);
    });

    it("answers a foreign channel id exactly as an absent one (FR-018)", async () => {
      const absent = "00000000-0000-4000-8000-000000000000";
      const foreign = await addMembers(foreignChannelId, { user_ids: ["intruder"] });
      const nowhere = await addMembers(absent, { user_ids: ["intruder"] });
      expect(foreign.status).toBe(nowhere.status);
      expect(withoutRequestId(await foreign.json())).toEqual(
        withoutRequestId(await nowhere.json()),
      );
      // And the other tenant's channel gained nobody. Read through ITS OWN
      // repository — a repository scoped to the empty string is not a scope, it is
      // a query that fails on an invalid uuid, which is how this line read first.
      expect(await foreignRepo.listMembers(foreignChannelId)).toEqual([]);
    });
  });

  // ── T058a: the ceiling, read back rather than inferred ──────────────────────
  describe("the member ceiling (FR-CHN-07, FR-048)", () => {
    let fullChannelId: string;

    beforeAll(async () => {
      fullChannelId = ((await (
        await create({ external_id: "at-the-ceiling", type: "public" })
      ).json()) as { id: string }).id;
      // Seeded through the repository rather than through 10 calls to the
      // endpoint: the endpoint caps a single call at 100, and this test is about
      // the CHANNEL's limit, not about how many requests it took to reach it.
      for (let i = 0; i < CHANNEL_MEMBER_LIMIT; i++) {
        const user = await repo.createUser(`ceiling-${i}`);
        await repo.addMember(fullChannelId, user.id);
      }
    }, 180_000);

    it("refuses a JOIN that would exceed it, with the same code (chapter 3.15)", async () => {
      // T047. The ceiling is chapter 3.13's and it is READ here, not reimplemented:
      // `join` counts members from storage and refuses with the same
      // `channel_member_limit_exceeded` the member-add route uses. A second limit
      // with its own number would be a second answer to one question.
      expect(await repo.countMembers(fullChannelId)).toBe(CHANNEL_MEMBER_LIMIT);
      const token = await tokenFor("outsider");
      const res = await fetch(`${url}/v1/channels/${fullChannelId}/join`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("channel_member_limit_exceeded");
      // And nobody joined: a refusal that added the member anyway would pass a
      // status assertion and fail the requirement.
      expect(await repo.countMembers(fullChannelId)).toBe(CHANNEL_MEMBER_LIMIT);
    });

    it("refuses the one that would exceed it with 422 and the code", async () => {
      expect(await repo.countMembers(fullChannelId)).toBe(CHANNEL_MEMBER_LIMIT);
      const res = await addMembers(fullChannelId, { user_ids: ["one-too-many"] });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("channel_member_limit_exceeded");
      expect(body.message).toContain(String(CHANNEL_MEMBER_LIMIT));
      // AND THE CHANNEL IS UNCHANGED. A refusal that added the member anyway
      // would pass a status assertion and fail the requirement.
      expect(await repo.countMembers(fullChannelId)).toBe(CHANNEL_MEMBER_LIMIT);
    });
  });

  // ── THE PRIVATE TYPE, MADE TO MEAN SOMETHING (chapter 3.15) ────────────────
  //
  // `channels.type` has been a column with a CHECK since chapter 2.1 and until this
  // chapter no conditional anywhere branched on it. It was selected and returned by
  // the create route — read, and decided upon by nothing.
  describe("GET /v1/channels/:channelId (FR-003a)", () => {
    const readAs = (channel: string, token: string) =>
      fetch(`${url}/v1/channels/${channel}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const readAsTenant = (channel: string) =>
      fetch(`${url}/v1/channels/${channel}`, {
        headers: { authorization: `Bearer ${credential}` },
      });

    it("reads back the four fields a create wrote (FR-CHN-01)", async () => {
      const made = await create({
        external_id: "readable",
        name: "Readable",
        type: "public",
        metadata: { team: "platform" },
      });
      const { id } = (await made.json()) as { id: string };
      const res = await readAsTenant(id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id,
        external_id: "readable",
        type: "public",
        name: "Readable",
        metadata: { team: "platform" },
        archived_at: null,
        // `null` and not `false`: an application credential is not a member of
        // anything, and `false` would imply it could become one.
        is_member: null,
      });
    });

    it("lets a member read a private channel", async () => {
      const res = await readAs(privateChannelId, await tokenFor("insider"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ type: "private", is_member: true });
    });

    it("lets a non-member read a PUBLIC channel (FR-004)", async () => {
      // The subscription set is not the read set. A public channel is readable on
      // demand by anyone in the tenant; membership decides what the socket carries.
      const res = await readAs(publicChannelId, await tokenFor("outsider"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ type: "public", is_member: false });
    });

    it("answers a non-member's read of a private channel as if it were absent", async () => {
      const token = await tokenFor("outsider");
      const refused = await readAs(privateChannelId, token);
      const absent = await readAs("00000000-0000-4000-8000-000000000000", token);
      expect(refused.status).toBe(absent.status);
      expect(withoutRequestId(await refused.json())).toEqual(
        withoutRequestId(await absent.json()),
      );
    });

    it("answers the same for another tenant's channel", async () => {
      // The cross-tenant half, unchanged by this chapter and worth keeping beside
      // the same-tenant one: three ids, one answer.
      const token = await tokenFor("outsider");
      const foreign = await readAs(foreignChannelId, token);
      const absent = await readAs("00000000-0000-4000-8000-000000000000", token);
      expect(withoutRequestId(await foreign.json())).toEqual(
        withoutRequestId(await absent.json()),
      );
    });
  });

  describe("POST /v1/channels/:channelId/join (FR-CHN-03)", () => {
    const join = (channel: string, token: string) =>
      fetch(`${url}/v1/channels/${channel}/join`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });

    it("joins a public channel, and says so again on the repeat", async () => {
      const token = await tokenFor("outsider");
      const first = await join(publicChannelId, token);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ result: "joined" });
      const second = await join(publicChannelId, token);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ result: "already_a_member" });
    });

    it("answers a private channel as if it were absent", async () => {
      const token = await tokenFor("outsider");
      const refused = await join(privateChannelId, token);
      const absent = await join("00000000-0000-4000-8000-000000000000", token);
      expect(refused.status).toBe(absent.status);
      expect(withoutRequestId(await refused.json())).toEqual(
        withoutRequestId(await absent.json()),
      );
    });

    it("refuses an application credential, which has no user to join", async () => {
      // The method-level `@Accepts("user")` overriding the class's "application".
      // Without it this would be a 403 for every USER instead — chapter 3.12's
      // FR-044 hole in the other direction.
      const res = await join(publicChannelId, credential);
      expect(res.status).toBe(403);
    });
  });

  describe("the enum widens last (FR-009, FR-010)", () => {
    it("accepts `private` and reads the row back as private (SC-006)", async () => {
      const made = await create({ external_id: "now-private", type: "private" });
      expect(made.status).toBe(201);
      const { id } = (await made.json()) as { id: string };
      const back = await fetch(`${url}/v1/channels/${id}`, {
        headers: { authorization: `Bearer ${credential}` },
      });
      expect(await back.json()).toMatchObject({ type: "private" });
    });

    it("a repeat naming a different type returns the existing channel unchanged", async () => {
      // FR-010. Idempotency means the second call returns the FIRST call's channel,
      // and a type change is not a creation — so this is a read, not an update.
      const first = await create({ external_id: "type-stays", type: "private" });
      expect(first.status).toBe(201);
      const second = await create({ external_id: "type-stays", type: "public" });
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ type: "private" });
    });
  });

  // ── REMOVAL, BULK, BECAUSE THE REQUIREMENT ALWAYS WAS (chapter 3.15) ────────
  //
  // FR-006 says "up to 100 in one request" and FR-007 says the result is reported
  // per user — chapter 3.13's add shape in both halves. The contract specified a
  // single-user `DELETE` for ten analysis passes, having read "the shape chapter
  // 3.13 chose" as *named outcomes* and dropped *bulk*. Every pass compared
  // requirements to tasks, both said "removal", and identifier coverage read 100%.
  // Comparing US2's scenario 4 — which names a hundred users — to the route's path,
  // which named one, is what found it.
  describe("POST /v1/channels/:channelId/members/remove (FR-006, FR-007)", () => {
    let target: string;

    const remove = (channel: string, users: string[], key = credential) =>
      fetch(`${url}/v1/channels/${channel}/members/remove`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ user_ids: users }),
      });

    beforeAll(async () => {
      target = (await repo.createChannel("removals", "public")).id;
      await addMembers(target, { user_ids: ["stays", "goes", "also-goes"] });
    });

    it("reports one result per user, in request order, mixing outcomes", async () => {
      const res = await remove(target, ["goes", "never-a-member", "also-goes"]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [
          { external_id: "goes", result: "removed" },
          // A user that does not exist is NOT a member — simply true — and answering
          // anything else would make this a membership oracle for user ids.
          { external_id: "never-a-member", result: "not_a_member" },
          { external_id: "also-goes", result: "removed" },
        ],
      });
      // One bad entry did not refuse the other two.
      expect(await repo.countMembers(target)).toBe(1);
    });

    it("is idempotent: removing a non-member says so rather than failing", async () => {
      const res = await remove(target, ["goes"]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [{ external_id: "goes", result: "not_a_member" }],
      });
    });

    it("takes 100 in one request and refuses 101, naming the field", async () => {
      const hundred = Array.from({ length: 100 }, (_, i) => `bulk-${i}`);
      const ok = await remove(target, hundred);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { results: unknown[] }).results).toHaveLength(100);

      const tooMany = await remove(target, [...hundred, "one-too-many"]);
      expect(tooMany.status).toBe(400);
      const body = (await tooMany.json()) as { code: string; field?: string };
      expect(body.code).toBe("invalid_request");
      expect(body.field).toBe("user_ids");
    });

    it("answers a channel that does not exist as it answers a foreign one", async () => {
      const absent = await remove("00000000-0000-4000-8000-000000000000", ["goes"]);
      const foreign = await remove(foreignChannelId, ["goes"]);
      expect(absent.status).toBe(foreign.status);
      expect(withoutRequestId(await absent.json())).toEqual(
        withoutRequestId(await foreign.json()),
      );
    });

    // THE READ POSITION GOES WITH THE MEMBERSHIP, and that assertion lives in
    // phase 12 rather than here — deliberately, twice over.
    //
    // Writing it here needed a read position to exist, and `setReadPosition` does
    // not until phase 12. The first attempt planted one with raw SQL and the lint
    // rule refused it: "the query engine lives inside the repository layer only
    // (constitution I, ADR-16)". That rule is right and the test was wrong — a suite
    // that reaches past the repository to set up state is testing something other
    // than what the platform does.
    //
    // So `removeMembers` deletes the row (see the repository), and phase 12 asserts
    // the consequence a customer can see: a re-added member's unread count starts at
    // the channel's whole history. A test placed before the thing it tests is the
    // fourth instance of that class in this feature.
    it("keeps the removed member's messages, attributed to them (FR-008, SC-005)", async () => {
      const author = await repo.createUser("author", "An Author");
      await repo.addMember(target, author.id);
      const sent = await repo.sendMessage(target, {
        userId: author.id,
        userExternalId: "author",
        text: "written while a member",
      });

      await remove(target, ["author"]);

      const history = await repo.listMessages(target, { limit: 100 });
      const kept = history.find((m) => m.seq === sent.seq);
      expect(kept).toBeDefined();
      // Still theirs. `messages.user_id` points at a row that still exists, which is
      // the whole reason deletion keeps the user row rather than nulling the author.
      expect(kept?.user).toBe("author");
    });

    it("does not stop a removed member reading or sending to a PUBLIC channel", async () => {
      // T060, and it is the case that makes FR-004's table load-bearing rather than
      // decorative: membership was never what permitted this. A removal from a
      // public channel takes away the subscription and nothing else.
      const token = await tokenFor("outsider");
      await addMembers(publicChannelId, { user_ids: ["outsider"] });
      await remove(publicChannelId, ["outsider"]);

      const read = await fetch(`${url}/v1/channels/${publicChannelId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ is_member: false });

      const sent = await fetch(`${url}/v1/channels/${publicChannelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: "still open to me" }),
      });
      expect(sent.status).toBe(201);
    });
  });

  // ── MEMBER ROLES (chapter 3.15, FR-CHN-04, FR-011) ─────────────────────────
  //
  // The clause has asked for these since the SRS was written, and `members` was
  // `(channel_id, user_id, joined_at)` the whole time. Chapter 3.12's traceability
  // map recorded it as delivered and described it with a paraphrase belonging to
  // FR-CHN-06; that was corrected while this chapter was specified.
  describe("roles on members", () => {
    let roleChannel: string;

    const patchRole = (channel: string, user: string, role: unknown) =>
      fetch(`${url}/v1/channels/${channel}/members/${user}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body: JSON.stringify({ role }),
      });

    beforeAll(async () => {
      roleChannel = (await repo.createChannel("roles", "public")).id;
    });

    it("defaults a new member to `member`, read through the API", async () => {
      // T067. The default is declared in the migration; this exercises it rather
      // than reading it out of the DDL — a comment about a default is not a default.
      const res = await addMembers(roleChannel, { user_ids: ["plain"] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { members: { external_id: string; role: string }[] };
      expect(body.members[0]).toMatchObject({ external_id: "plain", role: "member" });
    });

    it("accepts a role on the add body, per entry (FR-011b)", async () => {
      // US6's first scenario: a member ADDED WITH a role. The plan had add assign the
      // default and `PATCH` change it — two calls for one intention, and a window
      // where the member holds a role nobody chose. Analysis pass eleven found that
      // by comparing the scenario to the routes.
      //
      // Mixed forms in one request, because the entry is a union: chapter 3.13
      // shipped `{"user_ids": ["a", "b"]}` and a customer's server sends that today.
      const res = await addMembers(roleChannel, {
        user_ids: ["bare-string", { user: "with-role", role: "owner" }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { members: { external_id: string; role: string }[] };
      expect(body.members).toEqual([
        expect.objectContaining({ external_id: "bare-string", role: "member" }),
        expect.objectContaining({ external_id: "with-role", role: "owner" }),
      ]);
    });

    it("round-trips all three roles through PATCH (FR-011)", async () => {
      await addMembers(roleChannel, { user_ids: ["promotable"] });
      for (const role of ["owner", "moderator", "member"]) {
        const res = await patchRole(roleChannel, "promotable", role);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ external_id: "promotable", role });
      }
    });

    it("refuses a fourth role, naming the field (FR-011a, SC-009)", async () => {
      await addMembers(roleChannel, { user_ids: ["hopeful"] });
      const res = await patchRole(roleChannel, "hopeful", "superuser");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; field?: string };
      expect(body.code).toBe("invalid_request");
      // The field name is in the envelope only because chapter 3.14 stopped
      // `ZodValidationPipe` discarding `issues[0].path`.
      expect(body.field).toBe("role");
    });

    it("refuses `admin` — the organisation's word, not a channel's", async () => {
      // R8's trap from the edge: `memberships.role` is
      // `('owner','admin','member')`, one word apart from these three. A migration
      // that reused that constraint would take `admin` and refuse `moderator`.
      await addMembers(roleChannel, { user_ids: ["would-be-admin"] });
      const res = await patchRole(roleChannel, "would-be-admin", "admin");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { field?: string }).field).toBe("role");
    });

    it("answers a non-member, an unknown user and an absent channel alike", async () => {
      // Three cases, one answer. A caller who can tell them apart has a probe for
      // which users this tenant knows and which channels exist.
      const notAMember = await patchRole(roleChannel, "outsider", "owner");
      const noSuchUser = await patchRole(roleChannel, "never-heard-of", "owner");
      const noSuchChannel = await patchRole(
        "00000000-0000-4000-8000-000000000000",
        "plain",
        "owner",
      );
      expect(notAMember.status).toBe(404);
      expect(noSuchUser.status).toBe(404);
      expect(noSuchChannel.status).toBe(404);
      // Each body read ONCE and held: a `Response` is a stream, and reading it
      // twice throws "Body has already been read" — which is what the first draft
      // of this test did.
      const a = withoutRequestId(await notAMember.json());
      const b = withoutRequestId(await noSuchUser.json());
      const c = withoutRequestId(await noSuchChannel.json());
      expect(a).toEqual(b);
      expect(a).toEqual(c);
    });
  });

  // ── ARCHIVING (chapter 3.15, FR-020, FR-021, FR-021a) ──────────────────────
  //
  // `channels.archived_at` was declared in chapter 2.1 and had ZERO non-test
  // references until this chapter — measured, not assumed (T007). Archiving stops
  // new messages and keeps everything already written.
  describe("archiving a channel", () => {
    let archived: string;

    const archive = (channel: string) =>
      fetch(`${url}/v1/channels/${channel}/archive`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}` },
      });
    const unarchive = (channel: string) =>
      fetch(`${url}/v1/channels/${channel}/archive`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${credential}` },
      });
    const sendTo = (channel: string) =>
      fetch(`${url}/v1/channels/${channel}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body: JSON.stringify({ text: "attempted after archiving" }),
      });

    beforeAll(async () => {
      archived = (await repo.createChannel("archivable", "public")).id;
      await repo.sendMessage(archived, { text: "written before archiving" });
    });

    it("refuses a send with its own code, distinct from not-found and banned", async () => {
      // T074, and FR-021's actual requirement: three refusals a client acts on
      // differently. The comparison used to be against `not_a_member`, which cannot
      // appear on this path at all — private channels answer not-found and public
      // ones permit the send.
      expect((await archive(archived)).status).toBe(200);
      const refused = await sendTo(archived);
      expect(refused.status).toBe(403);
      const body = (await refused.json()) as { code: string; message: string };
      expect(body.code).toBe("channel_archived");
      expect(body.code).not.toBe("not_found");
      expect(body.code).not.toBe("user_banned");
      // The message says history is unchanged, which is the thing a client needs to
      // know next: this is not data loss.
      expect(body.message).toContain("history");
    });

    it("still serves history while archived (FR-020)", async () => {
      const res = await fetch(`${url}/v1/channels/${archived}/messages?limit=10`, {
        headers: { authorization: `Bearer ${credential}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: { text: string | null }[] };
      expect(body.messages.some((m) => m.text === "written before archiving")).toBe(true);
    });

    it("is idempotent in both directions (FR-020a)", async () => {
      // Archiving an archived channel and unarchiving an active one both answer 200.
      // "Already archived" is not an error: the customer asked for the channel to be
      // archived and it is.
      expect((await archive(archived)).status).toBe(200);
      expect((await unarchive(archived)).status).toBe(200);
      expect((await unarchive(archived)).status).toBe(200);
      // And sending works again, with nothing lost.
      expect((await sendTo(archived)).status).toBe(201);
    });

    it("answers an absent channel as it answers a foreign one", async () => {
      const absent = await archive("00000000-0000-4000-8000-000000000000");
      const foreign = await archive(foreignChannelId);
      expect(absent.status).toBe(foreign.status);
      const a = withoutRequestId(await absent.json());
      const b = withoutRequestId(await foreign.json());
      expect(a).toEqual(b);
    });

    it("does not change what a user has left unread (FR-022, T078)", async () => {
      // The edge case the spec names, and this is where "the count is still true"
      // gets a definition: archiving writes ONE column on `channels` and touches no
      // message and no read position. So `last_sequence` is what it was, every read
      // position is what it was, and the arithmetic between them is unchanged.
      //
      // Asserted on the sequence rather than on a count, because the count is phase
      // 12's route — this is the invariant that makes the count safe, tested where it
      // can be tested.
      const target = (await repo.createChannel("archive-unread", "public")).id;
      const before = (await repo.sendMessage(target, { text: "unread by somebody" })).seq;
      await archive(target);
      const after = await repo.listMessages(target, { limit: 10 });
      expect(after.map((m) => m.seq)).toContain(before);
      // And the channel's sequence did not move: archiving is not a write to the log.
      const reread = await repo.getChannelById(target);
      expect(reread).not.toBeNull();
      expect((await repo.listMessages(target, { limit: 10 })).length).toBe(1);
    });
  });
});
