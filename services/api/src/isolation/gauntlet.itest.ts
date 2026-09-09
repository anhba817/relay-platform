import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { mintUserToken } from "../auth/user-token";
import { environmentSigningSecret, Repository } from "../db/repository";
import { createDb, createPool } from "../db/client";
import {
  credentialAttack,
  listAttack,
  readAttack,
  rowsOf,
  send,
  writeAttack,
} from "./attack";
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
    // THE ATTACK PRESENTS A KEY, AND A KEY SEND NAMES A BOT
    // (FR-MSG-15). Without a sender both halves would be refused for naming
    // nobody — identically, so the pair would agree and this test would pass
    // while attacking the validator instead of the tenancy boundary.
    const from = { text: "from the attacker", user: t.attacker.botExternalId };
    const verdict = await writeAttack(
      url,
      t.attacker.credential,
      {
        method: "POST",
        path: `/v1/channels/${t.victim.channelId}/messages`,
        body: from,
      },
      {
        method: "POST",
        path: `/v1/channels/${ABSENT_UUID}/messages`,
        body: from,
      },
      () => t.victim.repo.listMessages(t.victim.channelId, { limit: 50 }),
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
    // AND THE REFUSAL IS THE TENANCY ONE. Without this the pair above agrees on any
    // shared refusal, including the validator's — drop `user` from `from` and both
    // halves become 400 `field: "user"`, `differences` stays empty and this test goes
    // on passing without ever reaching a channel.
    expect(verdict.foreign.status).toBe(404);
    // THE STATE READ IS THE POINT: a 404 that completed the write is the case no
    // status code reveals.
    expect(verdict.stateChanged, "the victim's messages moved").toBe(false);
  });

  // ── the revisions chapter's three routes ────────────────────────────────────────
  //
  // WRITTEN BECAUSE THE ACCOUNTING TEST AT THE BOTTOM OF THIS FILE ASKED FOR THEM. The
  // classification went in with the routes; the attacks did not, and the run that
  // followed named all three by path. That is the direction published Part 3 never
  // checked — a `write` classification with no attack written for it is the same hole as
  // an unclassified route, one level up.
  //
  // AND THE CREDENTIAL DIFFERS PER ROUTE, which is the whole reason `accepts` is on the
  // classification: the edit takes a user token only, the history an application
  // credential only, the deletion either. Attacking one with the wrong class would be
  // refused at the door and recorded as isolated without the handler ever running.
  it("GET .../messages/:messageId/edits — a foreign message's history reads as an absent one", async () => {
    attacked.add("GET /v1/channels/:channelId/messages/:messageId/edits");
    const verdict = await readAttack(
      url,
      t.attacker.credential,
      {
        method: "GET",
        path: `/v1/channels/${t.victim.channelId}/messages/${t.victim.messageId}/edits`,
      },
      {
        method: "GET",
        path: `/v1/channels/${ABSENT_UUID}/messages/${ABSENT_UUID}/edits`,
      },
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
    // THE REFUSAL IS THE TENANCY ONE, and without this the pair agrees on any shared
    // answer — including the `@Accepts("application")` guard's 403, which is what a key
    // swapped for a token here would produce on BOTH halves.
    expect(verdict.foreign.status).toBe(404);
    // AND THE PRIOR TEXT IS NOT IN THE BODY. FR-023a makes this the one route whose
    // 200 carries what a message USED to say, so an id-shaped comparison is not enough.
    expect(JSON.stringify(verdict.foreign.body)).not.toContain("victim");
  });

  it("PATCH .../messages/:messageId — a foreign message is not edited, and says so like an absent one", async () => {
    attacked.add("PATCH /v1/channels/:channelId/messages/:messageId");
    const verdict = await writeAttack(
      url,
      // A USER TOKEN, because `@Accepts("user")` is on the method: FR-MOD-02 grants a
      // tenant key deletion and is silent on editing. The attacker's token names the
      // attacker's OWN user, minted in `beforeAll` — the forged identifier is the
      // channel and the message, not the caller.
      attackerToken,
      {
        method: "PATCH",
        path: `/v1/channels/${t.victim.channelId}/messages/${t.victim.messageId}`,
        body: { text: "rewritten by the attacker" },
      },
      {
        method: "PATCH",
        path: `/v1/channels/${ABSENT_UUID}/messages/${ABSENT_UUID}`,
        body: { text: "rewritten by the attacker" },
      },
      () => t.victim.repo.listMessages(t.victim.channelId, { limit: 50 }),
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
    expect(verdict.foreign.status).toBe(404);
    // THE STATE READ IS WHAT A STATUS CANNOT SAY. The listing carries `text` and
    // `edited_at`, so a 404 that completed the edit shows up here and nowhere else.
    expect(verdict.stateChanged, "the victim's message text or edited_at moved").toBe(false);
  });

  it("DELETE .../messages/:messageId — a foreign message is not tombstoned", async () => {
    attacked.add("DELETE /v1/channels/:channelId/messages/:messageId");
    const verdict = await writeAttack(
      url,
      // A KEY, and this route inherits `@Accepts("application", "user")` from the class
      // rather than narrowing it, so the application half is the one attacked here — a
      // key may delete anybody's message WITHIN ITS OWN TENANT (FR-MOD-02), which is
      // precisely the permission that makes the tenancy boundary the only thing
      // standing between this credential and the victim's message.
      t.attacker.credential,
      {
        method: "DELETE",
        path: `/v1/channels/${t.victim.channelId}/messages/${t.victim.messageId}`,
      },
      {
        method: "DELETE",
        path: `/v1/channels/${ABSENT_UUID}/messages/${ABSENT_UUID}`,
      },
      () => t.victim.repo.listMessages(t.victim.channelId, { limit: 50 }),
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
    expect(verdict.foreign.status).toBe(404);
    // A DELETION IS THE ONE WRITE WHOSE SUCCESS LOOKS LIKE ITS REFUSAL from outside:
    // the route answers 204 with no body, so `stateChanged` is the entire assertion
    // that the tombstone was not written.
    expect(verdict.stateChanged, "the victim's message became a tombstone").toBe(false);
  });

  it("the three of them refuse the victim's message id inside the ATTACKER'S OWN channel", async () => {
    // THE SHAPE ONLY A NESTED ROUTE HAS, and the pair attacks above cannot express it:
    // they forge BOTH identifiers, so a route that checked only the channel would pass
    // them. Here the channel is the attacker's, legitimately visible, and the message
    // id is the victim's — which is the request a broken `messageExistsIn` answers.
    const before = await t.victim.repo.listMessages(t.victim.channelId, { limit: 50 });
    const own = `/v1/channels/${t.attacker.channelId}/messages/${t.victim.messageId}`;

    for (const [label, req, credential] of [
      ["history", { method: "GET", path: `${own}/edits` }, t.attacker.credential],
      ["edit", { method: "PATCH", path: own, body: { text: "reached" } }, attackerToken],
      ["deletion", { method: "DELETE", path: own }, t.attacker.credential],
    ] as const) {
      const answer = await send(url, credential, req);
      expect(answer.status, `${label} accepted a foreign message id`).toBe(404);
      expect(
        JSON.stringify(answer.body ?? ""),
        `${label} echoed the victim's message id`,
      ).not.toContain(t.victim.messageId);
    }

    const after = await t.victim.repo.listMessages(t.victim.channelId, { limit: 50 });
    expect(JSON.stringify(after), "the victim's message moved").toBe(JSON.stringify(before));
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

  it("GET /internal/memberships — the attacker's token hears only its own channels", async () => {
    attacked.add("GET /internal/memberships");
    // THE SAME ATTACK AS `/internal/session` AND FOR THE SAME REASON: nothing here is
    // forgeable but the credential. The backstop's whole job is to answer "what may
    // this connection hear now", so a leak here is a channel id the caller could then
    // subscribe to.
    const res = await fetch(`${url}/internal/memberships`, {
      headers: { authorization: `Bearer ${attackerToken}` },
    });
    const body: unknown = res.ok ? await res.json() : null;
    const serialised = JSON.stringify(body ?? "");
    expect(serialised).not.toContain(t.victim.channelId);
    expect(serialised).not.toContain(t.victim.userId);
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

    // ══ THE SENDER (T035, T036, SC-005) ════════════════════════
    //
    // HAND-WRITTEN, AND `attack.ts` NEEDS NO FIFTH SHAPE. The sender is a new DIMENSION
    // on a route already classified `write` and already attacked with a foreign channel
    // id — not a new kind of target. A generated shape would have to know that this
    // body field names a user in the caller's own tenant, which is one route's
    // knowledge and not the gauntlet's.
    describe("a foreign bot and a bot that exists nowhere", () => {
      // ── T036: THE CONTROL FIRST ───────────────────────────────────────────
      //
      // The isolation harness's fourteen green tests compared two refusals and meant nothing,
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
        // test needs one. `t.victim` is the tenant whose identifiers every attack
        // in this file borrows.
        const theirs = (
          await new Repository(db, t.victim.environmentId).upsertUser(
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

  // ── the ban: a write whose effect is a refusal somewhere else ───────────────────
  //
  // A ban is the first state on this platform whose whole purpose is to change what a
  // DIFFERENT request does. So the victim's state to read is not a row that looks
  // different — it is `banned_at`, and the assertion is that the caller's ban did not
  // land on somebody else's user.
  //
  // BOTH DIRECTIONS OF THE VERB, because an unban is a write too and the route pair is
  // the same shape. A scoping bug that could ban across tenants can unban across them,
  // and the second is worse: it removes a refusal the customer asked for.
  for (const [verb, method] of [["ban", "POST"], ["unban", "DELETE"]] as const) {
    it(`${verb}: a foreign user's banned_at does not move`, async () => {
      attacked.add(`${method} /v1/users/:externalId/ban`);
      // NO STATUS ASSERTION, AND THAT IS THIS CHAPTER'S DOING.
      //
      // These asserted 404 — the user is named in the path and there is no such user
      // in the caller's environment — and got 200. A user row is created implicitly
      // on first authentication now, so the credential attack above, which mints a
      // token for the victim's external id with the attacker's key, CREATES that name
      // in the attacker's environment. Nothing leaked: the row is the attacker's own,
      // with a name the attacker chose, exactly like the bulk upsert.
      //
      // But it means a foreign identifier no longer reliably answers not-found on any
      // user route, because presenting it may have created it. **The status stopped
      // being a signal and the state comparison is the whole assertion** — which is
      // what the pair was always supposed to be for.
      const before = await t.victim.repo.getUserByExternalId(t.victim.userExternalId);
      await fetch(
        `${url}/v1/users/${t.victim.userExternalId}/ban`,
        { method, headers: { authorization: `Bearer ${t.attacker.credential}` } },
      );
      const after = await t.victim.repo.getUserByExternalId(t.victim.userExternalId);
      expect(after, `the victim's user row moved on ${verb}`).toEqual(before);
      // AND SPECIFICALLY THE MARKER, named rather than left to the deep equality —
      // a future field added to the row would make the comparison above fail for a
      // reason that has nothing to do with a ban.
      expect(after?.banned_at ?? null, `the victim was ${verb}ned across tenants`)
        .toEqual(before?.banned_at ?? null);
    });
  }

  // ── bulk upsert and deletion: A ROUTE THAT ECHOES ITS INPUT HAS NO PAIR ─────────
  //
  // Both of these were written as `writeAttack` and both failed, correctly:
  //
  //     body {"data":[{"external_id":"victim-…-user","status":"created",…}]}  (foreign)
  //     vs   {"data":[{"external_id":"absent-0000…","status":"created",…}]}  (absent)
  //
  // The pair every other attack asserts — the foreign identifier and one that exists
  // nowhere must be indistinguishable — cannot hold here, because the response
  // ECHOES the identifier it was given. The two answers differ by construction, in
  // the one field the request chose, and no amount of correct scoping changes that.
  //
  // THIS IS A THIRD DISTINCTION IN THE SHAPE TAXONOMY, after `list`. A `write` shape
  // presumes a pair; a route whose body reflects its input can only be checked
  // against the victim's state. `POST /v1/users` also takes its identifiers in the
  // BODY rather than the path, so there is no foreign id in a URL to compare at all.
  //
  // So these two assert the half that carries the property: the victim's row, read
  // before and after, through the victim's own repository.
  it("POST /v1/users — a foreign external id creates in the caller's tenant only", async () => {
    attacked.add("POST /v1/users");
    const before = await t.victim.repo.getUserByExternalId(t.victim.userExternalId);
    const res = await fetch(`${url}/v1/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${t.attacker.credential}`,
      },
      body: JSON.stringify({ users: [{ external_id: t.victim.userExternalId }] }),
    });
    // A SUCCESS IS THE EXPECTED ANSWER, and that is the point. The id is a string in
    // the caller's own namespace: two tenants may both have a user called `alice`,
    // and `(environment_id, external_id)` is what keeps them apart. The upsert
    // SHOULD succeed — in the attacker's environment.
    expect(res.status).toBe(200);
    const after = await t.victim.repo.getUserByExternalId(t.victim.userExternalId);
    expect(after, "the victim's user row moved").toEqual(before);
  });

  it("DELETE /v1/users/:externalId — the same id in two tenants deletes one", async () => {
    attacked.add("DELETE /v1/users/:externalId");
    // THE COLLISION, MADE EXPLICIT AND OWNED BY THIS TEST. The first version presented
    // the victim's id and expected a 404 — and got a 200, because the upsert test above
    // had just created that id in the attacker's environment. A test that depends on a
    // sibling's side effect is the shared-fixture mutation this suite keeps finding.
    //
    // So the collision is seeded here: both tenants hold a user with the SAME external
    // id, which is legal — `(environment_id, external_id)` is the uniqueness — and the
    // delete then has two candidate rows and must choose by credential. That is a
    // stronger attack than a foreign id with no local twin, because a scoping bug and a
    // correct answer are the same status code.
    const shared = t.victim.userExternalId;
    await t.attacker.repo.createUser(shared, "the attacker's own");

    const before = await t.victim.repo.getUserByExternalId(shared);
    const res = await fetch(`${url}/v1/users/${shared}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${t.attacker.credential}` },
    });
    expect(res.status).toBe(200);

    // DELETION SETS `deleted_at` AND CLEARS THE PROFILE — the row stays. So its
    // EXISTENCE proves nothing and the comparison has to be on the whole row.
    const after = await t.victim.repo.getUserByExternalId(shared);
    expect(after, "the victim's user row moved").toEqual(before);
    expect(after?.deleted_at ?? null, "the victim's user was marked deleted").toBeNull();

    // And the attacker's own row IS deleted, which is what makes the assertion above
    // about scoping rather than about the delete failing altogether.
    const mine = await t.attacker.repo.getUserByExternalId(shared);
    expect(mine?.deleted_at ?? null, "the caller's own user was not deleted").not.toBeNull();
  });

  // ── the profile: a read pair and a write pair over the same path ────────────────
  //
  // Two routes on one path, and they take different attacks: `GET` is a read pair —
  // the foreign external id and one that exists nowhere must be indistinguishable —
  // and `PATCH` is a write, so the victim's own row has to be read back afterwards.
  //
  // THE VICTIM'S STATE IS THE PROFILE ITSELF, not a count. A PATCH that leaked
  // through would show up as a display name the victim never set, which is the one
  // thing a status code cannot report.
  it("GET /v1/users/:externalId — a foreign profile answers as an absent one", async () => {
    attacked.add("GET /v1/users/:externalId");
    const verdict = await readAttack(
      url,
      t.attacker.credential,
      { method: "GET", path: `/v1/users/${t.victim.userExternalId}` },
      { method: "GET", path: `/v1/users/nobody-${ABSENT_UUID}` },
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
  });

  it("PATCH /v1/users/:externalId — a foreign profile is not written", async () => {
    attacked.add("PATCH /v1/users/:externalId");
    const body = { display_name: "written by the attacker" };
    const verdict = await writeAttack(
      url,
      t.attacker.credential,
      { method: "PATCH", path: `/v1/users/${t.victim.userExternalId}`, body },
      { method: "PATCH", path: `/v1/users/nobody-${ABSENT_UUID}`, body },
      // Through the victim's own repository, scoped to its environment — the profile
      // as the victim would read it.
      () => t.victim.repo.getUserByExternalId(t.victim.userExternalId),
    );
    expect(verdict.differences, verdict.differences.join("; ")).toEqual([]);
    expect(verdict.stateChanged, "the victim's profile moved").toBe(false);
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
