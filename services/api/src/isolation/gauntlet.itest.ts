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
      const res = await fetch(`${url}/internal/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${attackerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ channel_id: tenants.victim.channelId, text: "not mine" }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      const after = await tenants.victim.repo.listMessages(tenants.victim.channelId, { limit: 50 });
      expect(JSON.stringify(after)).not.toContain("not mine");
    });

    it("POST /internal/backfill", async () => {
      const res = await fetch(`${url}/internal/backfill`, {
        method: "POST",
        headers: { authorization: `Bearer ${attackerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ cursor: { [tenants.victim.channelId]: 1 }, limit: 10 }),
      });
      const body = await res.text();
      expect(body).not.toContain(tenants.victim.messageId);
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
});
