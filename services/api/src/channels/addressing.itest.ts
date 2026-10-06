import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { mintUserToken } from "../auth/user-token";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";

// ADDRESSING A CHANNEL BY THE IDENTIFIER THE CUSTOMER GAVE IT (FR-CHN-11).
//
// FR-USR-01 says Relay shall not generate end-user identities and ADR-18 says an
// end user's identity is whatever `external_id` the customer already had. A uuid
// here is a KEY — for foreign keys, for ordering, and because a text primary key
// across 216,922 messages costs more than it is worth. The customer's string is
// the IDENTITY, and until this chapter not one of the thirteen routes beneath
// `/v1/channels/:channelId` would take it.
//
// THE FIRST ASSERTION IN THIS FILE IS THE ONLY ONE THAT COULD FAIL BEFORE A LINE
// WAS WRITTEN, and it did: an identifier nothing matches answered 500, because
// `'order-88412'::uuid` raises in Postgres before the `OR` beside it can
// short-circuit. The fix and the repair are one edit — a value that cannot be a
// uuid is never cast, so the error cannot arise.

describe("addressing a channel", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let credential: string;
  let repo: Repository;
  let ordersChannelId: string;
  let memberToken: string;
  let messageIds: string[];
  let foreignChannelId: string;

  const ORDER = "order-88412";
  const MEMBER = "member-of-88412";

  beforeAll(async () => {
    db = createDb(createPool());
    const env = await createEnvironment(db, { name: "addressing-itest" });
    repo = new Repository(db, env.id);
    credential = (await createApiKey(db, { environmentId: env.id })).credential;
    ordersChannelId = (await repo.createChannel(ORDER, "public")).id;
    const member = await repo.createUser(MEMBER, "A Member");
    await repo.addMember(ordersChannelId, member.id);

    // THE SAME IDENTIFIER IN ANOTHER TENANT. 1,597 external ids are reused across
    // environments in `users` today, so this is the common case and not a corner.
    const other = await createEnvironment(db, { name: "addressing-itest-other" });
    const foreignRepo = new Repository(db, other.id);
    foreignChannelId = (await foreignRepo.createChannel(ORDER, "public")).id;

    const secret = (await environmentSigningSecret(db, env.id))!.signingSecret;
    memberToken = (
      await mintUserToken(secret, { user: MEMBER, environmentId: env.id, ttlSeconds: 3600 })
    ).token;

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();

    // SENT WITH THE MEMBER'S OWN TOKEN, and that is four refusals' worth of
    // fixture. An application credential may send only as a BOT
    // (`sender_not_permitted`), and the edit and delete routes refuse an API key
    // outright (`wrong_credential_type`) because FR-013a will not let a key act
    // "as" somebody. So the author has to be a person with a token, and this
    // message is the one the three `:messageId` routes name.
    // ONE MESSAGE PER ARM, BECAUSE THE TABLE IS EXERCISED TWICE AND IT DELETES.
    // The first version shared a message: the identity pass edited it and then
    // tombstoned it, and the uuid pass answered 403 editing a tombstone — a
    // failure that looks exactly like the uuid path breaking and is the fixture.
    messageIds = [];
    while (messageIds.length < 2) {
      const sent = await fetch(`${url}/v1/channels/${ordersChannelId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ text: "one message to name" }),
      });
      messageIds.push(((await sent.json()) as { id: string }).id);
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const get = (path: string, key = credential) =>
    fetch(`${url}${path}`, { headers: { authorization: `Bearer ${key}` } });

  describe("an identifier that names nothing", () => {
    // T012. RED BEFORE THE CHAPTER: this answered 500 `internal_error` against
    // the composed api, measured, and the log carried the status with no cause —
    // one `"status":500` line, no `22P02`, nothing an operator could act on.
    it("is a 404 and not a 500", async () => {
      const res = await get("/v1/channels/order-nobody-created-this");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("not_found");
    });

    // THE CONTROL, which is what makes the assertion above a claim about the
    // SHAPE of the identifier rather than about the identifier being unknown.
    // A well-formed uuid nothing matches has always been a 404.
    it("answers the same as a well-formed uuid that names nothing", async () => {
      const identity = await get("/v1/channels/order-nobody-created-this");
      const key = await get(`/v1/channels/${randomUUID()}`);
      expect(identity.status).toBe(key.status);
      expect(await identity.json()).toMatchObject({ code: "not_found" });
      expect(await key.json()).toMatchObject({ code: "not_found" });
    });
  });

  describe("an identifier the customer chose", () => {
    it("reads the channel it names", async () => {
      const res = await get(`/v1/channels/${ORDER}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ external_id: ORDER, type: "public" });
    });

    it("reads the same channel the uuid reads", async () => {
      const byIdentity = await (await get(`/v1/channels/${ORDER}`)).json();
      const byKey = await (await get(`/v1/channels/${ordersChannelId}`)).json();
      expect(byIdentity).toEqual(byKey);
    });
  });

  // THE THIRTEEN, ONE ASSERTION EACH (SC-001, SC-002).
  //
  // A LOOP THAT REPORTS ONE NUMBER HIDES WHICH ROUTE REGRESSED, so the table is
  // the data and `it.each` makes each row its own test name. Every route is
  // exercised twice — once naming the channel the way the customer does and once
  // the way 173 existing call sites do — and the pair must agree on the status.
  const routes = (mid: string) => [
    { name: "GET    /v1/channels/:c", method: "GET", path: (c: string) => `/v1/channels/${c}` },
    { name: "POST   /v1/channels/:c/archive", method: "POST", path: (c: string) => `/v1/channels/${c}/archive` },
    { name: "DELETE /v1/channels/:c/archive", method: "DELETE", path: (c: string) => `/v1/channels/${c}/archive` },
    { name: "POST   /v1/channels/:c/members", method: "POST", path: (c: string) => `/v1/channels/${c}/members`, body: { user_ids: [MEMBER] } },
    { name: "POST   /v1/channels/:c/members/remove", method: "POST", path: (c: string) => `/v1/channels/${c}/members/remove`, body: { user_ids: ["nobody-here"] } },
    { name: "PATCH  /v1/channels/:c/members/:u", method: "PATCH", path: (c: string) => `/v1/channels/${c}/members/${MEMBER}`, body: { role: "member" } },
    { name: "POST   /v1/channels/:c/join", method: "POST", path: (c: string) => `/v1/channels/${c}/join`, user: true },
    { name: "POST   /v1/channels/:c/messages", method: "POST", path: (c: string) => `/v1/channels/${c}/messages`, body: { text: "hello" }, user: true },
    { name: "GET    /v1/channels/:c/messages", method: "GET", path: (c: string) => `/v1/channels/${c}/messages` },
    { name: "PATCH  /v1/channels/:c/messages/:m", method: "PATCH", path: (c: string) => `/v1/channels/${c}/messages/${mid}`, body: { text: "edited" }, user: true },
    { name: "GET    /v1/channels/:c/messages/:m/edits", method: "GET", path: (c: string) => `/v1/channels/${c}/messages/${mid}/edits` },
    { name: "DELETE /v1/channels/:c/messages/:m", method: "DELETE", path: (c: string) => `/v1/channels/${c}/messages/${mid}`, user: true },
    { name: "PUT    /v1/users/:u/channels/:c/read", method: "PUT", path: (c: string) => `/v1/users/${MEMBER}/channels/${c}/read`, body: { sequence: 0 } },
  ];

  const call = async (
    r: ReturnType<typeof routes>[number],
    channel: string,
    key?: string,
  ) => {
    const auth = key ?? (r.user ? memberToken : credential);
    return fetch(`${url}${r.path(channel)}`, {
      method: r.method,
      headers: {
        authorization: `Bearer ${auth}`,
        ...(r.body ? { "content-type": "application/json" } : {}),
      },
      ...(r.body ? { body: JSON.stringify(r.body) } : {}),
    });
  };

  describe("every route that names a channel", () => {
    it("is thirteen of them, which is the number the contract publishes", () => {
      expect(routes("x")).toHaveLength(13);
    });

    // INDEXED, NOT CLOSED OVER. `it.each` builds its table at collection time,
    // before `beforeAll` has run, so a route object captured there would hold an
    // undefined message id. The name is the key and the route is rebuilt inside
    // the test with the arm's own message.
    const names = routes("x").map((r, i) => [r.name, i] as const);

    it.each(names)("%s takes the customer's identifier", async (_name, i) => {
      const res = await call(routes(messageIds[0]!)[i]!, ORDER);
      expect(res.status).toBeLessThan(400);
    });

    it.each(names)("%s takes the Relay identifier, as it did before", async (_name, i) => {
      const res = await call(routes(messageIds[1]!)[i]!, ordersChannelId);
      expect(res.status).toBeLessThan(400);
    });
  });

  // SC-003 — NO INPUT PRODUCES A 5xx, IN ANY PATH PARAMETER.
  //
  // This closes gap 058-3, which counted sixteen shipped routes where a malformed
  // uuid in a path is a caller-triggered 500: thirteen taking `channelId`, three
  // taking `messageId`, one `mediaId` validated at chapter 4.12.
  describe("no input produces a 5xx", () => {
    const hostile = [
      ["a malformed value", "not%2Fa%2Fuuid"],
      ["a percent sign", "order%2588412"],
      ["an identifier nobody used", "order-nobody-created-this"],
      ["a uuid nobody used", "11111111-2222-3333-4444-555555555555"],
    ] as const;

    it.each(
      routes("x").flatMap((r, i) =>
        hostile.map(([why, seg]) => [`${r.name} · ${why}`, i, seg] as const),
      ),
    )("%s", async (_name, i, segment) => {
      const res = await call(routes(randomUUID())[i]!, segment);
      expect(res.status).toBeLessThan(500);
    });

    // ANOTHER TENANT'S CHANNEL, BY BOTH FORMS, AND THE ANSWER MUST BE THE SAME ONE
    // AN ABSENT CHANNEL GETS (SC-004, FR-TEN-05). The identifier is the common
    // case rather than the corner: the same string names a channel in both
    // environments and the caller must reach their own.
    it("a foreign tenant's uuid reads as an absent one", async () => {
      const res = await fetch(`${url}/v1/channels/${foreignChannelId}`, {
        headers: { authorization: `Bearer ${credential}` },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "not_found" });
    });

    it("the same identifier in two environments reaches the caller's own", async () => {
      const res = await fetch(`${url}/v1/channels/${ORDER}`, {
        headers: { authorization: `Bearer ${credential}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe(ordersChannelId);
      expect(body.id).not.toBe(foreignChannelId);
    });
  });

  // 058-3's LAST THREE (T020b). A malformed `:messageId` was a 500 until this
  // chapter; the control is a well-formed one that names nothing, which has
  // always been a 404 and must stay one.
  describe("a malformed message id", () => {
    // THE CREDENTIAL PER ROUTE IS PART OF THE FIXTURE. Edit and delete refuse an
    // API key before they look at the path, so a 400 from them under the wrong
    // credential would be `wrong_credential_type` and would prove nothing about
    // `:messageId`.
    const withMessageId = [
      ["PATCH", (m: string) => `/v1/channels/${ORDER}/messages/${m}`, { text: "x" }, true],
      ["DELETE", (m: string) => `/v1/channels/${ORDER}/messages/${m}`, undefined, true],
      ["GET", (m: string) => `/v1/channels/${ORDER}/messages/${m}/edits`, undefined, false],
    ] as const;

    it.each(withMessageId.map((r) => [`${r[0]} ${r[1]("…")}`, r] as const))(
      "%s answers 400 and names the field",
      async (_name, [method, path, body, asUser]) => {
        const res = await fetch(`${url}${path("not-a-uuid")}`, {
          method,
          headers: {
            authorization: `Bearer ${asUser ? memberToken : credential}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          code: "invalid_request",
          field: "messageId",
        });
      },
    );

    it.each(withMessageId.map((r) => [`${r[0]} ${r[1]("…")}`, r] as const))(
      "%s still answers 404 for a well-formed id that names nothing",
      async (_name, [method, path, body, asUser]) => {
        const res = await fetch(`${url}${path(randomUUID())}`, {
          method,
          headers: {
            authorization: `Bearer ${asUser ? memberToken : credential}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        expect(res.status).toBe(404);
      },
    );
  });

  // THE COLLISION, CONSTRUCTED RATHER THAN OBSERVED (T021, FR-003).
  //
  // An `external_id` may itself be a uuid — `z.string().min(1).max(255)` permits
  // it — and 0 of 41,772 channels have one. So this case is built here or it is
  // never tested. The IDENTITY wins: a customer who named a channel must reach
  // the channel they named, and the other stays reachable by its uuid from any
  // caller holding it. Key-first would strand them with no error they could act on.
  describe("an identifier that is itself another channel's uuid", () => {
    it("resolves to the channel that was NAMED, and the other keeps its uuid", async () => {
      const victim = await repo.createChannel("the-one-with-the-uuid", "public");
      const impostor = await repo.createChannel(victim.id, "public");
      expect(impostor.id).not.toBe(victim.id);

      const named = await (
        await fetch(`${url}/v1/channels/${victim.id}`, {
          headers: { authorization: `Bearer ${credential}` },
        })
      ).json();
      expect(named).toMatchObject({ id: impostor.id, external_id: victim.id });

      const byItsOwnName = await (
        await fetch(`${url}/v1/channels/the-one-with-the-uuid`, {
          headers: { authorization: `Bearer ${credential}` },
        })
      ).json();
      expect(byItsOwnName).toMatchObject({ id: victim.id });
    });
  });

  // FR-006 / SC-006 — WHAT A CUSTOMER RECEIVES THAT THEY CANNOT USE.
  //
  // The sweep that produced this went looking for the `GET /v1/users` listing
  // cursor ADR-37 names as its one live edge, found there is no such route, and
  // enumerated every v1 response shape instead. One field failed the test — an
  // identifier that is Relay's alone AND that no route accepts — and it was on a
  // write route everyone uses.
  describe("the internal key a customer could not use", () => {
    it("is gone from the member-add response", async () => {
      const res = await fetch(`${url}/v1/channels/${ORDER}/members`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
        body: JSON.stringify({ user_ids: [MEMBER] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { members: Record<string, unknown>[] };
      expect(body.members.length).toBeGreaterThan(0);
      for (const m of body.members) {
        expect(Object.keys(m).sort()).toEqual(["external_id", "role", "status"]);
      }
    });

    // THE CONTROL, and it is what makes the removal mean something: the value that
    // used to be in that field is accepted by nothing, while the one that stayed
    // is accepted by the route a customer would reach for.
    it("because no route took it, and the identity does", async () => {
      const row = await repo.getUserByExternalId(MEMBER);
      const byKey = await get(`/v1/users/${row!.id}`);
      const byIdentity = await get(`/v1/users/${MEMBER}`);
      expect(byKey.status).toBe(404);
      expect(byIdentity.status).toBe(200);
    });
  });
});
