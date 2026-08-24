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
});
