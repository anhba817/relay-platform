import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool } from "../db/client";
import { mintUserToken } from "../auth/user-token";
import { environmentSigningSecret } from "../db/repository";
import { credentialAttack, listAttack, readAttack, writeAttack } from "./attack";
import { nowhereId, seedTwoTenants, type TwoTenants } from "./fixtures";

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

  beforeAll(async () => {
    db = createDb(createPool());
    tenants = await seedTwoTenants(db);
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
        body: JSON.stringify({ text: "the control writes" }),
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
