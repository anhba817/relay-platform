import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool } from "../db/client";
import { mintUserToken } from "../auth/user-token";
import { environmentSigningSecret, Repository } from "../db/repository";
import { credentialAttack, listAttack, readAttack, writeAttack } from "./attack";
import { withoutRequestId } from "./compare";
import {
  nowhereId,
  seedCollidingTenants,
  seedSameTenant,
  seedTwoTenants,
  type CollidingTenants,
  type SameTenant,
  type TwoTenants,
} from "./fixtures";

import type { Db } from "../db/client";

// THE GAUNTLET (NFR-SEC-09, FR-TEN-05, constitution I).
//
// Every endpoint the api serves, attacked with another tenant's identifiers, on
// every build. Constitution I has required this suite since it was written; what
// the repository had instead was nine good isolation assertions in nine files, and
// nothing anywhere that knew which endpoints had been attacked and which had merely
// never been thought about.
//
// The target list is DERIVED, in `targets.itest.ts`, and classified in
// `targets.ts` — a route that exists and matches no classification fails the build.
// This file is the attacking half.
//
// ── WHAT THIS SUITE DOES NOT COVER, which matters as much as what it does ──────
//
// TIMING. A foreign id answering in 3 ms and an absent id in 30 ms is a disclosure
// this suite cannot see. Measuring that stably in CI is a different discipline and
// is not attempted here; the chapter names it as unaddressed rather than implying
// it is covered.
//
// A LEAKED PLATFORM CREDENTIAL. FR-044 narrowed which routes each internal service
// may call, and that is all it did. There is no rotation, and `service` is
// self-reported by which variable matched — so the change shrinks the blast radius
// of a leak and does not make one survivable.
//
// ROUTES THAT ARE UNSCOPED BY DESIGN. The four dispatch routes reach every tenant
// because the dispatcher serves every tenant. This suite checks WHO MAY CALL them,
// not whether they should exist.
//
// MESSAGE CONTENT BEYOND EQUALITY. The pair proves the two answers match. It does
// not prove that what they say is wise: a constant message leaking a schema detail
// would pass every assertion below.
//
// ANYTHING NOT ROUTED THROUGH THE HTTP ROUTER. A future admin socket, a CLI, a cron
// job reading across environments — none of those appear in `router.stack`, so none
// of them appear here.
//
// STORAGE-LEVEL LEAKS WITH NO ENDPOINT. `tenant-scope.itest.ts` checks that every
// table carries a tenant path; it does not check that a query respects the one it
// has. Those are two different claims and this file makes only the second.

describe("the isolation gauntlet", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let tenants: TwoTenants;
  let same: SameTenant;
  let colliding: CollidingTenants;

  beforeAll(async () => {
    db = createDb(createPool());
    // A token minter the fixtures can call without `fixtures.ts` importing the auth
    // module: it has never needed to, and the two shapes chapter 3.15 adds are the
    // only ones that want tokens.
    const mint = async (environmentId: string, userExternalId: string) => {
      const secret = (await environmentSigningSecret(db, environmentId))!.signingSecret;
      return (
        await mintUserToken(secret, {
          user: userExternalId,
          environmentId,
          ttlSeconds: 3600,
        })
      ).token;
    };
    tenants = await seedTwoTenants(db);
    same = await seedSameTenant(db, mint);
    colliding = await seedCollidingTenants(db, mint);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  // ── THE CONTROL, and it is not decoration ──────────────────────────────────
  //
  // Every assertion below compares two refusals. Two refusals for an unrelated
  // reason — an expired credential, a misconfigured lane, a route that 401s
  // everything — are also indistinguishable, and would pass every test in this
  // file while attacking nothing. So the suite first proves the attacker's
  // credential WORKS on the attacker's own resources. Without this, a green
  // gauntlet is compatible with a broken one.
  describe("the control: the attacking credential is a working credential", () => {
    it("reaches its own webhook endpoint", async () => {
      const res = await fetch(`${url}/v1/webhooks/${tenants.attacker.endpointId}`, {
        headers: { authorization: `Bearer ${tenants.attacker.credential}` },
      });
      expect(res.status).toBe(200);
    });

    it("reaches its own channel history, and sees its own message", async () => {
      const res = await fetch(`${url}/v1/channels/${tenants.attacker.channelId}/messages`, {
        headers: { authorization: `Bearer ${tenants.attacker.credential}` },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(tenants.attacker.messageId);
    });

    it("can write to its own channel", async () => {
      const res = await fetch(`${url}/v1/channels/${tenants.attacker.channelId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tenants.attacker.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "the control writes",
          // The attacking credential is a KEY, so it names a bot of its own tenant
          // (chapter 3.17). The control must keep proving the credential works.
          user: tenants.attacker.botExternalId,
        }),
      });
      expect(res.status).toBe(201);
    });
  });

  // ── T028: read ──────────────────────────────────────────────────────────────
  describe("read: a foreign resource answers as an absent one", () => {
    it("GET /v1/webhooks/:id", async () => {
      const verdict = await readAttack(
        url,
        tenants.attacker.credential,
        { method: "GET", path: `/v1/webhooks/${tenants.victim.endpointId}` },
        { method: "GET", path: `/v1/webhooks/${nowhereId()}` },
      );
      expect(verdict.differences).toEqual([]);
      // And it is a refusal, not a leak: a pair could be identical because both
      // returned the victim's row.
      expect(verdict.foreign.status).toBeGreaterThanOrEqual(400);
    });

    it("GET /v1/channels/:channelId/messages", async () => {
      const verdict = await readAttack(
        url,
        tenants.attacker.credential,
        { method: "GET", path: `/v1/channels/${tenants.victim.channelId}/messages` },
        { method: "GET", path: `/v1/channels/${nowhereId()}/messages` },
      );
      expect(verdict.differences).toEqual([]);
      // History is the one read whose refusal is an EMPTY PAGE and not a 404 —
      // chapter 2.4's shape, asserted in `history.itest.ts` by name. So the check
      // here is that nothing of the victim's came back, not that a status was 4xx.
      expect(JSON.stringify(verdict.foreign.body)).not.toContain(tenants.victim.messageId);
    });
  });

  // ── T029: list ──────────────────────────────────────────────────────────────
  it("list: GET /v1/webhooks returns an empty result and no foreign row", async () => {
    const empty = await seedTwoTenants(db); // a third tenant that owns no endpoint
    const verdict = await listAttack(url, empty.attacker.credential, { method: "GET", path: "/v1/webhooks" }, [
      tenants.victim.endpointId,
    ]);
    expect(verdict.status).toBe(200);
    expect(verdict.leaked).toEqual([]);
    // Its own endpoint is there; the other tenant's is not. A list that returned
    // nothing at all would pass a leak check while being broken.
    expect(verdict.count).toBe(1);
  });

  // ── T030: the seven public writes ───────────────────────────────────────────
  describe("write: a foreign identifier changes nothing", () => {
    const victimEndpoints = () => tenants.victim.repo.listEndpoints();
    const victimMessages = () =>
      tenants.victim.repo.listMessages(tenants.victim.channelId, { limit: 50 });

    it("POST /v1/channels/:channelId/messages", async () => {
      const verdict = await writeAttack(
        url,
        tenants.attacker.credential,
        {
          method: "POST",
          path: `/v1/channels/${tenants.victim.channelId}/messages`,
          body: { text: "written by the wrong tenant" },
        },
        { method: "POST", path: `/v1/channels/${nowhereId()}/messages`, body: { text: "nowhere" } },
        victimMessages,
      );
      expect(verdict.differences).toEqual([]);
      expect(verdict.stateChanged).toBe(false);
    });

    it("POST /v1/webhooks", async () => {
      // The create route takes no identifier, so the attack is that a create by A
      // cannot appear in B's list. Included because an earlier draft of the shape
      // table omitted this route entirely and summed to 21 against a derived 22.
      const verdict = await writeAttack(
        url,
        tenants.attacker.credential,
        { method: "POST", path: "/v1/webhooks", body: { url: "https://a.example/x", event_types: ["message.created"] } },
        { method: "POST", path: "/v1/webhooks", body: { url: "https://a.example/y", event_types: ["message.created"] } },
        victimEndpoints,
      );
      expect(verdict.stateChanged).toBe(false);
    });

    it.each([
      ["POST", "rotate-secret"],
      ["POST", "enable"],
      ["POST", "disable"],
      ["POST", "test"],
    ])("%s /v1/webhooks/:id/%s", async (method, action) => {
      const verdict = await writeAttack(
        url,
        tenants.attacker.credential,
        { method, path: `/v1/webhooks/${tenants.victim.endpointId}/${action}` },
        { method, path: `/v1/webhooks/${nowhereId()}/${action}` },
        victimEndpoints,
      );
      expect(verdict.differences).toEqual([]);
      expect(verdict.stateChanged).toBe(false);
    });

    it("DELETE /v1/webhooks/:id", async () => {
      const verdict = await writeAttack(
        url,
        tenants.attacker.credential,
        { method: "DELETE", path: `/v1/webhooks/${tenants.victim.endpointId}` },
        { method: "DELETE", path: `/v1/webhooks/${nowhereId()}` },
        victimEndpoints,
      );
      expect(verdict.differences).toEqual([]);
      expect(verdict.stateChanged).toBe(false);
    });
  });

  // ── T026 / T028: the credential shape ───────────────────────────────────────
  it("credential: a key for one environment cannot mint a token that works in another", async () => {
    const verdict = await credentialAttack(url, tenants.attacker.credential, "borrowed", {
      method: "GET",
      path: `/v1/channels/${tenants.victim.channelId}/messages`,
    });
    expect(verdict.minted).toBe(true);
    // The token is valid — it just belongs to another tenant, so the victim's
    // channel must be as invisible to it as it is to the key that minted it.
    expect(JSON.stringify(verdict.crossBody)).not.toContain(tenants.victim.messageId);
  });

  // ── T031a: the three internal routes that take an end-user token ────────────
  // ── Chapter 3.12's own two routes, attacked on the build that added them ────
  //
  // FR-021: a chapter that adds an endpoint attacks it in the same chapter. The
  // derivation found these before this file mentioned them — `targets.itest.ts`
  // went from 22 to 24 and failed naming both as unclassified.
  describe("write: the channel surface this chapter added", () => {
    it("POST /v1/channels/:channelId/members", async () => {
      const verdict = await writeAttack(
        url,
        tenants.attacker.credential,
        {
          method: "POST",
          path: `/v1/channels/${tenants.victim.channelId}/members`,
          body: { user_ids: ["intruder"] },
        },
        {
          method: "POST",
          path: `/v1/channels/${nowhereId()}/members`,
          body: { user_ids: ["intruder"] },
        },
        () => tenants.victim.repo.listMembers(tenants.victim.channelId),
      );
      expect(verdict.differences).toEqual([]);
      expect(verdict.stateChanged).toBe(false);
    });

    // POST /v1/channels CARRIES NO IDENTIFIER TO FORGE, so the pair here is not
    // foreign-versus-absent. What a caller can present is the other tenant's own
    // `external_id`, and the property is non-interference rather than
    // indistinguishability: the call must SUCCEED — two tenants may use the same
    // customer-supplied id, which is the whole point of scoping it per
    // environment — and it must neither return the victim's channel nor touch it.
    //
    // Getting this wrong would not look like a leak. It would look like a
    // convenience: "the channel already exists, here it is."
    it("POST /v1/channels with the other tenant's external id makes a NEW channel", async () => {
      const before = await tenants.victim.repo.getChannelByExternalId(
        tenants.victim.channelExternalId,
      );
      expect(before).not.toBeNull();

      const res = await fetch(`${url}/v1/channels`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tenants.attacker.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          external_id: tenants.victim.channelExternalId,
          type: "public",
        }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; external_id: string };
      expect(created.external_id).toBe(tenants.victim.channelExternalId);
      expect(created.id).not.toBe(tenants.victim.channelId);

      // The victim's row is untouched — same id, same name.
      const after = await tenants.victim.repo.getChannelByExternalId(
        tenants.victim.channelExternalId,
      );
      expect(after).toEqual(before);
    });
  });

  // ── THE SAME-TENANT NON-MEMBER (chapter 3.15, FR-034, SC-015) ──────────────
  //
  // Every attack above crosses a tenant boundary. This block does not, and that is
  // the case constitution I's suite never had: the channel is in the caller's own
  // environment, the environment predicate passes, and the only thing between the
  // caller and the rows is a membership check this chapter wrote.
  //
  // THE PAIR IS THE SAME SHAPE AS EVERY OTHER ONE HERE — the private channel the
  // caller cannot see against an id that exists nowhere — because SC-002 asks for
  // the same property inside a tenant that FR-TEN-05 asks for across tenants.
  describe("same tenant, not a member", () => {
    const asUser = (token: string, method: string, path: string, body?: unknown) =>
      fetch(`${url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    // ── the control, for the reason the cross-tenant block needed one ─────────
    //
    // Three of the four assertions below say NOTHING HAPPENED. A token the guard
    // rejects outright makes nothing happen too, and would pass all of them while
    // testing no membership at all. So the MEMBER is shown to work first.
    describe("the control: the member's token works on the same channel", () => {
      it("reads it by id", async () => {
        const res = await asUser(same.member.token, "GET", `/v1/channels/${same.privateChannelId}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ is_member: true });
      });

      it("reads its history", async () => {
        const res = await asUser(
          same.member.token,
          "GET",
          `/v1/channels/${same.privateChannelId}/messages?limit=10`,
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as { messages: unknown[] }).messages.length).toBeGreaterThan(0);
      });

      it("sends into it", async () => {
        const res = await asUser(
          same.member.token,
          "POST",
          `/v1/channels/${same.privateChannelId}/messages`,
          { text: "the control speaks" },
        );
        expect(res.status).toBe(201);
      });
    });

    const verbs: ReadonlyArray<
      readonly [string, string, (channel: string) => string, unknown?]
    > = [
      ["read by id", "GET", (c) => `/v1/channels/${c}`],
      ["read history", "GET", (c) => `/v1/channels/${c}/messages?limit=10`],
      ["send", "POST", (c) => `/v1/channels/${c}/messages`, { text: "not mine" }],
      ["join", "POST", (c) => `/v1/channels/${c}/join`],
      // THE FIFTH VERB (SC-001a, chapter 3.15's T121a). Its route is built in the
      // unread-count phase rather than with the other four, so it joins the oracle
      // here — the verb list is the authority and the count of verbs is not written
      // down anywhere, which is the fix for a number that went three, then four,
      // then five while its verification task stayed at three.
      //
      // THE USER IN THE PATH IS THE STRANGER'S OWN EXTERNAL ID. Under a user token the
      // route's subject and the path's user are the same person, so this attacks the
      // channel and nothing else — a mismatched pair is a different test (T082a).
      [
        "set a read position",
        "PUT",
        (c) => `/v1/users/${same.stranger.externalId}/channels/${c}/read`,
        { sequence: 0 },
      ],
    ];

    for (const [name, method, path, body] of verbs) {
      it(`${name}: the private channel answers as an id that exists nowhere`, async () => {
        const refused = await asUser(same.stranger.token, method, path(same.privateChannelId), body);
        const absent = await asUser(same.stranger.token, method, path(nowhereId()), body);
        expect(refused.status).toBe(absent.status);
        // The bodies too, `request_id` excepted. Matching statuses is the easy half
        // and says nothing on its own — chapter 3.12's oracle exists because of it.
        const a = withoutRequestId(await refused.json());
        const b = withoutRequestId(await absent.json());
        expect(a).toEqual(b);
      });
    }

    it("the private channel gained nothing from the refused send", async () => {
      // Read the state rather than infer it from the refusal. A refusal that wrote
      // the row anyway is the failure this assertion exists for.
      const history = await asUser(
        same.member.token,
        "GET",
        `/v1/channels/${same.privateChannelId}/messages?limit=100`,
      );
      const body = (await history.json()) as { messages: { text: string | null }[] };
      expect(body.messages.some((m) => m.text === "not mine")).toBe(false);
    });

    // ── T155a: THE BAN'S OWN PAIR (FR-021a, FR-031) ──────────────────────────
    //
    // T072 left the slot and only Phase 15 could fill it, because until then nothing
    // wrote `banned_at`. The ban check runs **before the channel is read**, which is what
    // this pair asserts: a banned user gets `user_banned` for a channel that exists and
    // for one that does not, and the two answers are byte-identical.
    //
    // ANY OTHER POSITION LEAKS. Check the channel first and the refusal for a real
    // channel differs from the refusal for an invented one — so a banned user can
    // enumerate channel ids by watching which refusal comes back. That is the same defect
    // as the archived-channel leak one requirement over, and this is the half of FR-021a
    // that could not be tested until now.
    describe("a banned user gets one answer for every channel id", () => {
      it("refuses a real channel and an invented one identically", async () => {
        await fetch(`${url}/v1/users/${same.stranger.externalId}/ban`, {
          method: "POST",
          headers: { authorization: `Bearer ${same.credential}` },
        });
        try {
          const real = await asUser(
            same.stranger.token,
            "POST",
            `/v1/channels/${same.publicChannelId}/messages`,
            { text: "banned but real" },
          );
          const invented = await asUser(
            same.stranger.token,
            "POST",
            `/v1/channels/${nowhereId()}/messages`,
            { text: "banned and invented" },
          );
          expect(real.status).toBe(403);
          expect(invented.status).toBe(403);
          const a = withoutRequestId(await real.json());
          const b = withoutRequestId(await invented.json());
          expect(a).toEqual(b);
          expect((a as { code: string }).code).toBe("user_banned");
        } finally {
          // Unbanned in a `finally`, because every other test in this block uses the
          // same stranger and a leaked ban would turn their refusals into this one.
          await fetch(`${url}/v1/users/${same.stranger.externalId}/ban`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${same.credential}` },
          });
        }
      });
    });

    // ══ THE SENDER (chapter 3.17, T035, T036, SC-005) ════════════════════════
    //
    // HAND-WRITTEN, AND `attack.ts` NEEDS NO FIFTH SHAPE. The sender is a new DIMENSION
    // on a route already classified `write` and already attacked with a foreign channel
    // id — not a new kind of target. A generated shape would have to know that this
    // body field names a user in the caller's own tenant, which is one route's
    // knowledge and not the gauntlet's.
    describe("a foreign bot and a bot that exists nowhere (chapter 3.17)", () => {
      // ── T036: THE CONTROL FIRST ───────────────────────────────────────────
      //
      // Chapter 3.12's fourteen green tests compared two refusals and meant nothing,
      // because the thing they attacked was refused for an unrelated reason. If this
      // control does not pass, the pair below proves only that both sends failed.
      it("the control: the same credential, the same channel, its OWN bot — 201", async () => {
        const res = await fetch(
          `${url}/v1/channels/${same.publicChannelId}/messages`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${same.credential}`,
            },
            body: JSON.stringify({ text: "the control", user: same.bot.externalId }),
          },
        );
        expect(res.status).toBe(201);
      });

      it("refuses a foreign bot and an invented identifier identically", async () => {
        const post = (user: string) =>
          fetch(`${url}/v1/channels/${same.publicChannelId}/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${same.credential}`,
            },
            body: JSON.stringify({ text: "not mine to send as", user }),
          });

        // A BOT IN ANOTHER TENANT, planted here rather than in the fixture: the point
        // is a real, resolvable identifier that belongs to somebody else, and only this
        // test needs one. `tenants.victim` is the tenant whose identifiers every attack
        // in this file borrows.
        const theirs = (
          await new Repository(db, tenants.victim.environmentId).upsertUser(
            "victim-bot",
            { kind: "bot", description: "the victim tenant's own software" },
          )
        ).user;

        const foreign = await post(theirs.external_id);
        const invented = await post("a-bot-that-exists-in-no-tenant");

        expect(foreign.status).toBe(400);
        expect(invented.status).toBe(400);
        const a = withoutRequestId(await foreign.json());
        const b = withoutRequestId(await invented.json());
        // If these differ by one byte, naming an identifier is a way to ask whether
        // another tenant has one — and a bot's identifier is often its purpose spelled
        // out, so the answer would leak what the neighbour's software does.
        expect(a).toEqual(b);
        expect((a as { field: string }).field).toBe("user");
      });
    });

    it("a PUBLIC channel of the same tenant is open to the same non-member (FR-004)", async () => {
      // The other half of what makes `channels.type` decide something. If both types
      // refused, the column would still be deciding nothing.
      const res = await asUser(same.stranger.token, "GET", `/v1/channels/${same.publicChannelId}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ is_member: false });
    });
  });

  // ── THE IDENTIFIER COLLISION (chapter 3.15, FR-034a) ───────────────────────
  //
  // The same `external_id` in two environments, `public` in one and `private` in the
  // other. `seedTenant` label-prefixes every id, so the pair it mints can never
  // collide — and all four attack shapes take an id that does NOT exist in the
  // attacker's tenant. The case where the same STRING resolves in both had no
  // fixture at all (analysis pass twelve).
  describe("the same external id in two tenants, one public and one private", () => {
    it("resolves to each tenant's own channel and never the other's", async () => {
      const open = await fetch(`${url}/v1/channels`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${colliding.open.credential}`,
        },
        body: JSON.stringify({ external_id: colliding.sharedExternalId, type: "public" }),
      });
      // The idempotent repeat returns the tenant's OWN channel, not the other's.
      expect(open.status).toBe(200);
      expect(await open.json()).toMatchObject({ id: colliding.open.channelId });

      const closed = await fetch(`${url}/v1/channels`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${colliding.closed.credential}`,
        },
        body: JSON.stringify({ external_id: colliding.sharedExternalId, type: "private" }),
      });
      expect(closed.status).toBe(200);
      expect(await closed.json()).toMatchObject({ id: colliding.closed.channelId });
    });

    it("answers the two tenants' users differently, and the TYPE is why", async () => {
      // The public tenant's non-member reads their channel; the private tenant's
      // non-member cannot read theirs. Same external id, different answer — and the
      // difference has to be the type rather than the tenant, which is what the
      // third assertion pins down.
      const openRead = await fetch(`${url}/v1/channels/${colliding.open.channelId}`, {
        headers: { authorization: `Bearer ${colliding.open.token}` },
      });
      expect(openRead.status).toBe(200);

      const closedRead = await fetch(`${url}/v1/channels/${colliding.closed.channelId}`, {
        headers: { authorization: `Bearer ${colliding.closed.token}` },
      });
      expect(closedRead.status).toBe(404);

      // And neither can reach the other's row with their own credential, which is
      // the cross-tenant property holding while the ids are identical.
      const across = await fetch(`${url}/v1/channels/${colliding.closed.channelId}`, {
        headers: { authorization: `Bearer ${colliding.open.token}` },
      });
      expect(across.status).toBe(404);
    });
  });

  describe("internal, end-user token: a token minted in one environment is refused in another", () => {
    let attackerToken: string;

    beforeAll(async () => {
      const secret = (await environmentSigningSecret(db, tenants.attacker.environmentId))!
        .signingSecret;
      attackerToken = (
        await mintUserToken(secret, {
          user: tenants.attacker.userExternalId,
          environmentId: tenants.attacker.environmentId,
          ttlSeconds: 3600,
        })
      ).token;
    });

    it("POST /internal/messages", async () => {
      // The pair, not just a 4xx. "Refused" and "refused for the same reason a
      // channel that does not exist is refused" are different claims, and only
      // the second one is isolation: an answer that says "not yours" where the
      // absent id says "no such channel" has disclosed that the channel exists.
      const verdict = await writeAttack(
        url,
        attackerToken,
        {
          method: "POST",
          path: "/internal/messages",
          body: { channel_id: tenants.victim.channelId, text: "not mine" },
        },
        {
          method: "POST",
          path: "/internal/messages",
          body: { channel_id: nowhereId(), text: "not mine" },
        },
        () => tenants.victim.repo.listMessages(tenants.victim.channelId, { limit: 50 }),
      );
      expect(verdict.differences).toEqual([]);
      expect(verdict.stateChanged).toBe(false);
      expect(JSON.stringify(verdict.after)).not.toContain("not mine");
    });

    it("POST /internal/backfill", async () => {
      const verdict = await writeAttack(
        url,
        attackerToken,
        {
          method: "POST",
          path: "/internal/backfill",
          body: { cursor: { [tenants.victim.channelId]: 1 }, limit: 10 },
        },
        { method: "POST", path: "/internal/backfill", body: { cursor: { [nowhereId()]: 1 }, limit: 10 } },
        () => tenants.victim.repo.listMessages(tenants.victim.channelId, { limit: 50 }),
      );
      expect(verdict.differences).toEqual([]);
      expect(verdict.stateChanged).toBe(false);
      expect(JSON.stringify(verdict.foreign.body)).not.toContain(tenants.victim.messageId);
    });

    it("POST /internal/session", async () => {
      const res = await fetch(`${url}/internal/session`, {
        method: "POST",
        headers: { authorization: `Bearer ${attackerToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      // The session names the channels this user may hear. The other tenant's is
      // not one of them, and `channelsForUser` is scoped by the token's own
      // environment — this is the assertion that the scoping is real.
      expect(body).not.toContain(tenants.victim.channelId);
    });
  });
  // ── T031: the five platform routes, and what isolation means for them ──────
  //
  // T031b, the comment the plan asked for: a platform credential is not
  // tenant-scoped and is not meant to be. The dispatcher serves every tenant, so
  // its credential reaches every tenant's deliveries. FR-044 narrowed WHICH
  // ROUTES each service may call and changed nothing about that reach.
  //
  // So the attack shape differs here, and the difference is worth stating
  // exactly. Only TWO of the five platform routes name an environment alongside
  // an identifier — `dispatch/expand` (`environment_id` beside `event_id`) and
  // `usage/connections` (an environment per connection). Those two can be told
  // to act on environment A while carrying something from B, and both are
  // attacked: expand below, connections by `usage.itest.ts`'s
  // `connection_environment_conflict` assertion (T032).
  //
  // The other three — `material`, `outcome`, `replay` — take one opaque
  // identifier and DERIVE the environment from the row they find. There is no
  // cross-environment request to make, because the caller never says which
  // environment it means. That is not a hole this suite declines to test; it is
  // the absence of the parameter that would make the attack expressible. What
  // guards them is FR-044 and nothing else — which is why `material`, the one
  // response in the platform that returns a decrypted customer secret, is the
  // route to watch first if a platform credential ever leaks.
  describe("the platform routes (T031, T031b)", () => {
    const dispatcher = process.env["RELAY_INTERNAL_CREDENTIAL"] ?? "";

    // Through the victim's OWN repository, which is both scoped and the only
    // place the query engine is allowed to live (FR-043).
    const victimDeliveries = () =>
      tenants.victim.repo.countDeliveriesForEndpoint(tenants.victim.endpointId);

    it("expand reaches only the endpoints of the environment it names", async () => {
      const before = await victimDeliveries();
      const res = await fetch(`${url}/internal/dispatch/expand`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${dispatcher}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event_id: crypto.randomUUID(),
          environment_id: tenants.attacker.environmentId,
          type: "message.created",
          payload: { text: "expand names one environment" },
        }),
      });
      expect(res.status).toBe(200);
      // The attacker's own endpoint subscribes to this type, so the call did
      // something — without this the assertion below passes on a no-op.
      expect((await res.json()).created).toBeGreaterThan(0);
      expect(await victimDeliveries()).toBe(before);
    });

    it("expand naming an environment that exists nowhere creates nothing", async () => {
      const before = await victimDeliveries();
      const res = await fetch(`${url}/internal/dispatch/expand`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${dispatcher}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event_id: crypto.randomUUID(),
          environment_id: nowhereId(),
          type: "message.created",
          payload: { text: "no such environment" },
        }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).created).toBe(0);
      expect(await victimDeliveries()).toBe(before);
    });
  });
});
