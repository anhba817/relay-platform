import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { mintUserToken } from "../auth/user-token";
import { environmentSigningSecret } from "../db/repository";
import { createDb, createPool } from "../db/client";
import { credentialAttack, listAttack, readAttack, rowsOf, writeAttack } from "./attack";
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
import { CLASSIFICATIONS, targetKey } from "./targets";

import type { Db } from "../db/client";

// THE GAUNTLET (NFR-SEC-09, constitution I).
//
// Two tenants over real HTTP. The attacker holds a valid credential for its own
// environment and presents the victim's identifiers with it. Every attack asserts a
// PAIR — the foreign identifier and one that exists nowhere must be indistinguishable —
// because "it returned 404" is a claim about a status code and constitution I is a
// claim about what a caller can learn.
//
// AN ATTACK PER NON-EXEMPT ROUTE, AND THE SUITE PROVES IT RAN THEM. A classification
// saying `write` with no attack written for it is the same hole as a route with no
// classification, one level up. The last test in this file compares what ran against
// what the list says should have run.

const ABSENT_UUID = "00000000-0000-4000-8000-000000000000";

describe("the isolation gauntlet", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let pool: ReturnType<typeof createPool>;
  let t: TwoTenants;
  /** A token minted with the ATTACKER's key, for the routes that take one. */
  let attackerToken: string;
  let same: SameTenant;
  let colliding: CollidingTenants;
  const attacked = new Set<string>();

  beforeAll(async () => {
    pool = createPool();
    db = createDb(pool);
    t = await seedTwoTenants(db);
    // A token minter the fixtures can call without `fixtures.ts` importing the auth
    // module: it has never needed to, and the two shapes this chapter adds are the
    // only ones that want tokens.
    const mintForFixture = async (environmentId: string, userExternalId: string) => {
      const secret = (await environmentSigningSecret(db, environmentId))!.signingSecret;
      return (
        await mintUserToken(secret, {
          user: userExternalId,
          environmentId,
          ttlSeconds: 3600,
        })
      ).token;
    };
    same = await seedSameTenant(db, mintForFixture);
    colliding = await seedCollidingTenants(db, mintForFixture);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();

    const mint = await fetch(`${url}/auth/dev-token`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${t.attacker.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ user: t.attacker.userExternalId }),
    });
    expect(mint.ok, "the attacker must be able to mint a token for its OWN user").toBe(
      true,
    );
    attackerToken = ((await mint.json()) as { token: string }).token;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ── read ────────────────────────────────────────────────────────────────────────
  it("GET /v1/channels/:channelId/messages — a foreign channel reads as an absent one", async () => {
    attacked.add("GET /v1/channels/:channelId/messages");
    const verdict = await readAttack(
      url,
      t.attacker.credential,
      { method: "GET", path: `/v1/channels/${t.victim.channelId}/messages` },
      { method: "GET", path: `/v1/channels/${ABSENT_UUID}/messages` },
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
  });

  // ── write ───────────────────────────────────────────────────────────────────────
  it("POST /v1/channels/:channelId/messages — refuses, and writes nothing", async () => {
    attacked.add("POST /v1/channels/:channelId/messages");
    const verdict = await writeAttack(
      url,
      t.attacker.credential,
      {
        method: "POST",
        path: `/v1/channels/${t.victim.channelId}/messages`,
        body: { text: "from the attacker" },
      },
      {
        method: "POST",
        path: `/v1/channels/${ABSENT_UUID}/messages`,
        body: { text: "from the attacker" },
      },
      () => t.victim.repo.listMessages(t.victim.channelId, { limit: 50 }),
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
    // THE STATE READ IS THE POINT: a 404 that completed the write is the case no
    // status code reveals.
    expect(verdict.stateChanged, "the victim's messages moved").toBe(false);
  });

  it("POST /internal/messages — a foreign channel_id refuses, and writes nothing", async () => {
    attacked.add("POST /internal/messages");
    const verdict = await writeAttack(
      url,
      attackerToken,
      {
        method: "POST",
        path: "/internal/messages",
        body: { channel_id: t.victim.channelId, text: "from the attacker" },
      },
      {
        method: "POST",
        path: "/internal/messages",
        body: { channel_id: ABSENT_UUID, text: "from the attacker" },
      },
      () => t.victim.repo.listMessages(t.victim.channelId, { limit: 50 }),
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
    expect(verdict.stateChanged, "the victim's messages moved").toBe(false);
  });

  it("POST /internal/backfill — a foreign channel yields nothing", async () => {
    attacked.add("POST /internal/backfill");
    const verdict = await writeAttack(
      url,
      attackerToken,
      {
        method: "POST",
        path: "/internal/backfill",
        body: { cursors: { [t.victim.channelId]: 0 } },
      },
      { method: "POST", path: "/internal/backfill", body: { cursors: { [ABSENT_UUID]: 0 } } },
      () => t.victim.repo.listMessages(t.victim.channelId, { limit: 50 }),
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
    expect(verdict.stateChanged).toBe(false);
    // AND THE BODY MUST CARRY NO ROWS. A backfill answers with messages rather than a
    // status, so "indistinguishable from absent" is necessary and not sufficient — an
    // endpoint that returned the victim's messages for BOTH requests would pass the
    // pair comparison and fail the product.
    const serialised = JSON.stringify(verdict.foreign.body ?? "");
    expect(serialised).not.toContain(t.victim.messageId);
    expect(serialised).not.toContain("victim says something");
  });

  // ── credential ──────────────────────────────────────────────────────────────────
  it("POST /auth/dev-token — a token minted for one environment is refused by another", async () => {
    attacked.add("POST /auth/dev-token");
    const verdict = await credentialAttack(
      url,
      t.attacker.credential,
      // The attacker asks for a token naming the VICTIM's user. Either the mint
      // refuses, or the token it hands back must be useless against the victim.
      t.victim.userExternalId,
      { method: "GET", path: `/v1/channels/${t.victim.channelId}/messages` },
    );
    if (verdict.minted) {
      expect(
        verdict.crossStatus,
        `a token minted with the attacker's key reached the victim's channel: ` +
          JSON.stringify(verdict.crossBody),
      ).not.toBe(200);
    }
  });

  it("POST /internal/session — the attacker's token resolves only its own environment", async () => {
    attacked.add("POST /internal/session");
    const res = await fetch(`${url}/internal/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${attackerToken}` },
    });
    const body: unknown = res.ok ? await res.json() : null;
    const serialised = JSON.stringify(body ?? "");
    // Whatever it answers, nothing of the victim's may appear in it.
    expect(serialised).not.toContain(t.victim.userId);
    expect(serialised).not.toContain(t.victim.channelId);
    expect(serialised).not.toContain(t.victim.environmentId);
  });

  // ── the two routes this chapter added ──────────────────────────────────────────
  //
  // A chapter that adds an endpoint attacks it in the same chapter. The derivation
  // found these before the classification did: `targets.itest.ts` went from 9 targets
  // to 11 and failed naming both as unclassified.
  it("POST /v1/channels/:channelId/members — refuses, and adds nobody", async () => {
    attacked.add("POST /v1/channels/:channelId/members");
    const verdict = await writeAttack(
      url,
      t.attacker.credential,
      {
        method: "POST",
        path: `/v1/channels/${t.victim.channelId}/members`,
        body: { user_ids: ["intruder"] },
      },
      {
        method: "POST",
        path: `/v1/channels/${ABSENT_UUID}/members`,
        body: { user_ids: ["intruder"] },
      },
      () => t.victim.repo.listMembers(t.victim.channelId),
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
    expect(verdict.stateChanged, "the victim gained a member").toBe(false);
  });

  it("POST /v1/channels — the other tenant's external_id is not interference", async () => {
    attacked.add("POST /v1/channels");
    // THIS ROUTE CARRIES NO IDENTIFIER TO FORGE, so the pair is not foreign-versus-
    // absent. What a caller can present is the other tenant's own `external_id`, and
    // the property is NON-INTERFERENCE rather than indistinguishability: the call must
    // SUCCEED. Two tenants may use the same customer-supplied id — that is the whole
    // point of scoping it per environment — and the victim's channel must be untouched.
    const before = await t.victim.repo.getChannelByExternalId(t.victim.channelExternalId);
    const res = await fetch(`${url}/v1/channels`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${t.attacker.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ external_id: t.victim.channelExternalId, type: "public" }),
    });
    expect([200, 201]).toContain(res.status);
    const created = (await res.json()) as { id?: string };
    expect(created.id).not.toBe(t.victim.channelId);
    const after = await t.victim.repo.getChannelByExternalId(t.victim.channelExternalId);
    expect(after?.id).toBe(before?.id);
  });

  // ── THE SAME-TENANT NON-MEMBER (FR-034, SC-015) ──────────────
  //
  // Every attack above crosses a tenant boundary. This block does not, and that is
  // the case constitution I's suite never had: the channel is in the caller's own
  // environment, the environment predicate passes, and the only thing between the
  // caller and the rows is a membership check this chapter wrote.
  //
  // THE PAIR IS THE SAME SHAPE AS EVERY OTHER ONE HERE — the private channel the
  // caller cannot see against an id that exists nowhere — because SC-002 asks for
  // the same property inside a tenant that FR-TEN-05 asks for across t.
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
      // THE FIFTH VERB (SC-001a, THE CHANNEL-CONTROL CHAPTER'S T121a). Its route is built in the
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
        // and says nothing on its own — the isolation harness's oracle exists because of it.
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

    it("a PUBLIC channel of the same tenant is open to the same non-member (FR-004)", async () => {
      // The other half of what makes `channels.type` decide something. If both types
      // refused, the column would still be deciding nothing.
      const res = await asUser(same.stranger.token, "GET", `/v1/channels/${same.publicChannelId}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ is_member: false });
    });
  });

  // ── THE IDENTIFIER COLLISION (FR-034a) ─────────────────────────────────────
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

  // ── THE SIX ROUTES THIS CHAPTER ADDED, ATTACKED ACROSS TENANTS ────────────────
  //
  // The blocks above attack the same tenant's private channel — a non-member of your
  // own environment. These six are the ordinary cross-tenant shape, and they exist
  // because the accounting test below said so: it named all six as classified and
  // never attacked, on the build that classified them.
  //
  // THE ATTACKS WERE NOT PORTED WITH THE ROUTES, which is the part worth recording.
  // The commit that built the channel surface carried its gauntlet attacks alongside
  // six webhook target rows, and the webhook half was deferred to the chapter that
  // builds webhooks — so the attacks went with them. Nothing said so. What said so
  // was a suite that compares what ran against what the classification lists, which
  // is the only reason a deferral could not quietly become a hole.
  //
  // ONE PARAMETERISED BLOCK, because all six take the same shape: the victim's
  // channel id against an id that exists nowhere, with the caller's own credential.
  // A separate `it` per route would repeat the pair six times and hide that it is
  // one property.
  describe("write: the channel surface this chapter added", () => {
    const routes: ReadonlyArray<
      readonly [string, string, (channel: string) => string, unknown?]
    > = [
      ["GET /v1/channels/:channelId", "GET", (c) => `/v1/channels/${c}`],
      ["POST /v1/channels/:channelId/join", "POST", (c) => `/v1/channels/${c}/join`],
      [
        "POST /v1/channels/:channelId/members/remove",
        "POST",
        (c) => `/v1/channels/${c}/members/remove`,
        { users: ["nobody"] },
      ],
      [
        "PATCH /v1/channels/:channelId/members/:userExternalId",
        "PATCH",
        (c) => `/v1/channels/${c}/members/nobody`,
        { role: "moderator" },
      ],
      ["POST /v1/channels/:channelId/archive", "POST", (c) => `/v1/channels/${c}/archive`],
      ["DELETE /v1/channels/:channelId/archive", "DELETE", (c) => `/v1/channels/${c}/archive`],
    ];

    for (const [key, method, path, body] of routes) {
      it(`${key}: a foreign channel answers as an absent one, and changes nothing`, async () => {
        attacked.add(key);
        const verdict = await writeAttack(
          url,
          t.attacker.credential,
          { method, path: path(t.victim.channelId), body },
          { method, path: path(ABSENT_UUID), body },
          // THE VICTIM'S SIDE, read with the victim's own repository. Two of these
          // routes mutate membership and two mutate the channel row, so the state
          // that has to be unchanged is both — a refusal that archived the channel
          // anyway leaves the message list untouched and is still a breach.
          async () => ({
            channel: await t.victim.repo.getChannelById(t.victim.channelId),
            members: await t.victim.repo.countMembers(t.victim.channelId),
          }),
        );
        expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
        expect(verdict.stateChanged, "the victim's channel or members moved").toBe(false);
      });
    }
  });

  // ── the read position: `either`, so it is attacked as both ──────────────────────
  //
  // The first route on the users controller that genuinely takes both credential
  // classes — a user records their own position, and the tenant records one for the
  // user it names — so `accepts: "either"` is a statement about which attacks apply
  // rather than a shrug. Both do.
  //
  // AND THE VICTIM'S STATE IS ITS UNREAD COUNT, read through the listing. There is no
  // getter for a read position, and adding one for a test would be a method the
  // product does not need; the count is what the position is FOR, and a write that
  // moved somebody else's position shows up there.
  it("PUT .../channels/:channelId/read — a foreign channel changes no position", async () => {
    attacked.add("PUT /v1/users/:externalId/channels/:channelId/read");
    const verdict = await writeAttack(
      url,
      t.attacker.credential,
      {
        method: "PUT",
        path: `/v1/users/${t.victim.userExternalId}/channels/${t.victim.channelId}/read`,
        body: { sequence: 1 },
      },
      {
        method: "PUT",
        path: `/v1/users/${t.victim.userExternalId}/channels/${ABSENT_UUID}/read`,
        body: { sequence: 1 },
      },
      () => t.victim.repo.listChannelsForUser(t.victim.userId, { limit: 50 }),
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
    expect(verdict.stateChanged, "the victim's unread count moved").toBe(false);
  });

  // ── list: the shape whose refusal is an EMPTY page ──────────────────────────────
  //
  // The first `list` target, and the first attack here that does NOT assert a pair.
  // Every other one compares the foreign identifier against an id that exists
  // nowhere and requires them indistinguishable. A listing cannot work that way:
  // the user is named in the path, so a foreign external id is a 404 — correctly —
  // while a user who exists and owns nothing is a 200 with no rows. Comparing those
  // two says nothing at all.
  //
  // So the property is narrower and it is the one that matters: **no identifier
  // belonging to another environment appears in any answer.**
  describe("list: GET /v1/users/:externalId/channels", () => {
    const FOREIGN = () => [
      t.victim.channelId,
      t.victim.channelExternalId,
      t.victim.userId,
      t.victim.messageId,
    ];

    it("answers a foreign external id as absent, and echoes none of its ids", async () => {
      attacked.add("GET /v1/users/:externalId/channels");
      const verdict = await listAttack(
        url,
        t.attacker.credential,
        { method: "GET", path: `/v1/users/${t.victim.userExternalId}/channels` },
        FOREIGN(),
      );
      // A 404 IS THE RIGHT ANSWER AND NOT THE ASSERTION. The user is in the path, so
      // not-found is what a caller gets for anybody outside their environment — and
      // a 404 that named the victim's channel in its body would still be a breach.
      expect(verdict.leaked, `leaked: ${verdict.leaked.join(", ")}`).toEqual([]);
      expect(verdict.count, "a refused listing returned rows").toBe(0);
    });

    it("answers its OWN user with its own rows, and none of the other tenant's", async () => {
      // THE CONTROL, and without it the case above passes against a route that
      // answers 404 for everybody. This is also the only place the `list` shape's
      // real property can be observed: a 200 that has rows in it.
      const verdict = await listAttack(
        url,
        t.attacker.credential,
        { method: "GET", path: `/v1/users/${t.attacker.userExternalId}/channels` },
        FOREIGN(),
      );
      expect(verdict.status).toBe(200);
      expect(verdict.count, "the attacker's own listing came back empty").toBeGreaterThan(0);
      expect(verdict.leaked, `leaked: ${verdict.leaked.join(", ")}`).toEqual([]);
    });

    it("recognised the response shape it counted", () => {
      // `rowsOf` RETURNS AN EMPTY ARRAY FOR A SHAPE IT DOES NOT KNOW, and a count of
      // zero from an unrecognised shape reads exactly like a count of zero from a
      // correctly-scoped list. That is the one answer this block must never confuse
      // with success, so the recogniser is asserted against both shapes it claims to
      // handle and against one it does not.
      expect(rowsOf([1, 2])).toHaveLength(2);
      expect(rowsOf({ data: [1] })).toHaveLength(1);
      expect(rowsOf({ items: [1, 2, 3] })).toEqual([]);
      expect(rowsOf(null)).toEqual([]);
    });
  });

  // ── and the suite accounts for itself ───────────────────────────────────────────
  it("ran an attack for every route the classification says to attack", () => {
    const shouldAttack = CLASSIFICATIONS.filter((c) => c.shape !== "exempt").map(targetKey);
    const missing = shouldAttack.filter((k) => !attacked.has(k));
    // A classification saying `write` with no attack written for it is the same hole
    // as a route with no classification, one level up. Named, because the useful half
    // of this failure is WHICH route nobody wrote a test for.
    expect(missing, `classified but never attacked: ${missing.join(", ")}`).toEqual([]);
  });
});
