import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool } from "../db/client";
import { credentialAttack, readAttack, writeAttack } from "./attack";
import { seedTwoTenants, type TwoTenants } from "./fixtures";
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
  const attacked = new Set<string>();

  beforeAll(async () => {
    pool = createPool();
    db = createDb(pool);
    t = await seedTwoTenants(db);
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
