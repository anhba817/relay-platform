import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  provisionOrganisation,
  Repository,
  revokeApiKey,
} from "../db/repository";
import { MAX_TOKEN_LIFETIME_SECONDS } from "./user-token";

// The refusals, over real HTTP against the compose Postgres.
// Invariants 1-7, 9 and 11 of contracts/credentials.md live here; 8 and 12 are
// pure and live in the unit lane; 10 needs a socket and lives in the gateway's
// session.itest.ts.
//
// Every environment in this file is minted here. Two suites sharing an
// environment would let one suite's key see another's channels — 2.1's
// isolation property is what makes a test lane like this cheap.

describe("credentials", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;

  let env: { id: string };
  let key: { id: string; credential: string };
  let channelId: string;

  let foreign: { id: string };
  let foreignKey: { credential: string };
  let foreignChannelId: string;

  let production: { id: string };
  let productionKey: { credential: string };

  const post = (body: unknown, credential?: string, channel = channelId) =>
    fetch(`${url}/v1/channels/${channel}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const devToken = (credential: string, body: unknown = { user: "tuan" }) =>
    fetch(`${url}/auth/dev-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify(body),
    });

  /** A token this api would accept, or a deliberately broken variant of one —
   * signed with the environment's own secret, the way the real minter does. */
  const signToken = async (
    over: {
      env?: string;
      sub?: string;
      iat?: number;
      exp?: number;
      secret?: string;
    } = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const secret =
      over.secret ?? (await environmentSigningSecret(db, env.id))!.signingSecret;
    return new SignJWT({ env: over.env ?? env.id })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(over.sub ?? "tuan")
      .setIssuedAt(over.iat ?? now)
      .setExpirationTime(over.exp ?? now + 3600)
      .sign(new TextEncoder().encode(secret));
  };

  beforeAll(async () => {
    db = createDb(createPool());

    env = await createEnvironment(db, { name: "credentials-itest" });
    key = await createApiKey(db, { environmentId: env.id });
    const repo = new Repository(db, env.id);
    channelId = (await repo.createChannel("general", "public")).id;
    await repo.createUser("tuan", "Tuan");

    foreign = await createEnvironment(db, { name: "credentials-itest-other" });
    foreignKey = await createApiKey(db, { environmentId: foreign.id });
    foreignChannelId = (
      await new Repository(db, foreign.id).createChannel("theirs", "public")
    ).id;

    production = await createEnvironment(db, {
      name: "credentials-itest-prod",
      kind: "production",
    });
    productionKey = await createApiKey(db, { environmentId: production.id });

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it("invariant 1: a key's secret is returned once and is unrecoverable afterwards", async () => {
    const minted = await createApiKey(db, {
      environmentId: env.id,
      name: "once",
    });
    // THE SECRET IS WHAT FOLLOWS THE PREFIX, NOT WHAT FOLLOWS THE LAST UNDERSCORE.
    //
    // This read `credential.split("_").at(-1)`, and the secret is base64url — whose
    // alphabet INCLUDES `_`. So the split returned whatever came after the secret's
    // own last underscore: usually a long tail, and the assertion passed for the
    // right reason; occasionally two characters, and it passed for no reason at all.
    //
    // Then it failed. `expected '[{"public_id":…' not to contain 'WA'` — a
    // two-character tail that appears inside the base64 SALT stored beside it, which
    // reads like the api leaking the secret it had just hashed. Measured cause, not
    // guessed: the salt in that row was `7XKYdYc_ottu61KbLY4dWA`.
    //
    // The prefix is a known constant and the row stores it, so removing it by length
    // is exact and cannot depend on the secret's contents.
    // `minted.prefix` IS THE ANSWER AND IT WAS ALREADY BEING RETURNED. The first
    // repair of this used `lastIndexOf("_")`, which is the SAME fault a second time:
    // the last underscore in the credential can belong to the secret.
    const secret = minted.credential.slice(minted.prefix.length);
    // A GUARD, because the whole failure above was an assertion on a short string.
    // A secret this test can compare has to be long enough that a chance collision
    // is not the thing being measured.
    expect(secret.length, "the secret is too short to assert on").toBeGreaterThan(20);

    // Nothing in the row it left behind contains what was returned. Read with
    // a plain string rather than drizzle's `sql` helper: the query engine lives
    // inside the repository layer and nowhere else (constitution I, ADR-16),
    // and the lint rule that says so does not make an exception for tests.
    const stored = JSON.stringify(
      (
        await db.execute(
          `SELECT public_id, secret_hash, salt, prefix, name
             FROM api_keys WHERE id = '${minted.id}'`,
        )
      ).rows,
    );
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(minted.credential);

    // And it still works — unrecoverable is not the same as unusable.
    expect((await post({ text: "with the new key" }, minted.credential)).status).toBe(
      201,
    );
  });

  it("invariant 2: no credential is a 401 that names what the route expects", async () => {
    const res = await post({ text: "anonymous" });
    expect(res.status).toBe(401);
    // EIR-API-04's envelope is flat — { code, message, docs_url } — the same
    // shape 2.2 established and the WebSocket error frame mirrors.
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("unauthorized");
    expect(body.message.toLowerCase()).toMatch(/credential|api key|token/);
  });

  it("invariant 3: the wrong class is a 403 naming presented and expected", async () => {
    // The chapter's subject: an end-user token presented to a route that wants
    // an API key. Not a 401 — the credential is valid, it is the wrong KIND.
    const token = await signToken();
    const res = await devToken(token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("wrong_credential_type");
    expect(body.message).toMatch(/API key/i);
    expect(body.message).toMatch(/end-user token/i);
    // Never the credential itself (NFR-SEC-06).
    expect(body.message).not.toContain(token);
  });

  it("invariant 4: a foreign key sees nothing, and it looks exactly like absent", async () => {
    const foreignAnswer = await post({ text: "trespass" }, foreignKey.credential);
    const absentAnswer = await post(
      { text: "nowhere" },
      key.credential,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(foreignAnswer.status).toBe(404);
    expect(absentAnswer.status).toBe(404);
    expect(await foreignAnswer.json()).toEqual(await absentAnswer.json());

    // And the reverse direction, so the test cannot pass by both being broken.
    expect(
      (await post({ text: "mine" }, foreignKey.credential, foreignChannelId))
        .status,
    ).toBe(201);
  });

  it("invariant 5: a revoked key is refused on the very next request", async () => {
    const doomed = await createApiKey(db, {
      environmentId: env.id,
      name: "doomed",
    });
    expect((await post({ text: "before" }, doomed.credential)).status).toBe(201);
    await revokeApiKey(db, doomed.id);
    // No wait, no cache to expire: verification is a live query (research R7).
    expect((await post({ text: "after" }, doomed.credential)).status).toBe(401);
  });

  it("invariant 6: several active keys work at once, which is what rotation needs", async () => {
    const second = await createApiKey(db, {
      environmentId: env.id,
      name: "rotation",
    });
    expect((await post({ text: "old key" }, key.credential)).status).toBe(201);
    expect((await post({ text: "new key" }, second.credential)).status).toBe(201);
  });

  it("invariant 7: a token is refused when expired, malformed, mis-signed, foreign, or over-long", async () => {
    const now = Math.floor(Date.now() / 1000);
    const read = (credential?: string) =>
      fetch(`${url}/v1/channels/${channelId}/messages`, {
        headers: credential ? { authorization: `Bearer ${credential}` } : {},
      });

    // A good one first, so the refusals below mean something.
    expect((await read(await signToken())).status).toBe(200);

    expect((await read(await signToken({ exp: now - 60, iat: now - 3600 }))).status)
      .toBe(401);
    expect((await read("eyJhbGciOiJIUzI1NiJ9.not-a-token")).status).toBe(401);
    expect((await read(await signToken({ secret: "wrong-secret" }))).status).toBe(
      401,
    );
    expect((await read(await signToken({ env: foreign.id }))).status).toBe(401);
    expect(
      (
        await read(
          await signToken({
            iat: now,
            exp: now + MAX_TOKEN_LIFETIME_SECONDS + 60,
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("invariant 9: the dev-token endpoint mints in development and does not exist in production", async () => {
    const minted = await devToken(key.credential);
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { token: string; expires_at: string };
    expect(typeof body.token).toBe("string");
    expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now());

    // The token it minted is a usable credential, which is the whole point of
    // the endpoint existing (FR-AUT-09).
    expect(
      (
        await fetch(`${url}/v1/channels/${channelId}/messages`, {
          headers: { authorization: `Bearer ${body.token}` },
        })
      ).status,
    ).toBe(200);

    // A production key gets a 404, not a 403: the route is not a permission
    // this caller lacks, it is an affordance that does not exist there.
    const refused = await devToken(productionKey.credential);
    expect(refused.status).toBe(404);

    // FR-AUT-07's bound is enforced at the endpoint too.
    expect(
      (await devToken(key.credential, { user: "tuan", ttl_seconds: 86_401 }))
        .status,
    ).toBe(400);
    expect((await devToken(key.credential, {})).status).toBe(400);
  });

  it("invariant 11: no credential appears in a log line or an error body", async () => {
    // The one request-log line per request (1.4's middleware) plus every error
    // envelope, captured while credentials are used and abused.
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: typeof original }).write = ((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof original;

    const token = await signToken();
    const bodies: string[] = [];
    try {
      for (const attempt of [
        post({ text: "logged" }, key.credential),
        post({ text: "logged" }, `${key.credential}-tampered`),
        post({ text: "logged" }, foreignKey.credential),
        devToken(token),
        post({ text: "logged" }),
      ]) {
        bodies.push(await (await attempt).text());
      }
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
    }

    const haystack = captured.join("") + bodies.join("");
    const secret = key.credential.split("_").at(-1)!;
    expect(haystack).not.toContain(key.credential);
    expect(haystack).not.toContain(secret);
    expect(haystack).not.toContain(foreignKey.credential);
    expect(haystack).not.toContain(token);
    // The prefix alone is not a secret and may legitimately appear.
  });

  it("signup hands over exactly one key, and only when it creates something", async () => {
    // R8: with no console session, signup is the only thing that can bootstrap
    // a first credential. The second call to the same identity must not mint a
    // second one (FR-AUT-02: the old secret is gone, and rotation is the answer).
    const account = `credentials-itest-${Date.now()}`;
    const first = await provisionOrganisation(db, {
      provider: "github",
      providerAccountId: account,
      organisationName: "first key co",
    });
    expect(first.created).toBe(true);
    expect(first.apiKey).toBeDefined();
    expect(first.apiKey!.secret.startsWith("rk_dev_")).toBe(true);

    const again = await provisionOrganisation(db, {
      provider: "github",
      providerAccountId: account,
      organisationName: "first key co",
    });
    expect(again.created).toBe(false);
    expect(again.apiKey).toBeUndefined();

    // And the key it did hand over works on the environment it belongs to.
    const repo = new Repository(db, first.environment.id);
    const channel = await repo.createChannel("signup-key", "public");
    expect(
      (await post({ text: "bootstrapped" }, first.apiKey!.secret, channel.id))
        .status,
    ).toBe(201);
  });

  // ══ FR-USR-02: A USER ROW ON FIRST AUTHENTICATION ════════════
  //
  // FR-039a and FR-039b arrived from research after the spec's nine stories were
  // written, so these have no story label — their coverage is two edge cases and SC-020.
  describe("a user record is created implicitly on first authentication", () => {
    const internalSend = (token: string, channel: string, text: string) =>
      fetch(`${url}/internal/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ channel_id: channel, text }),
      });

    // ── T158: SC-020, end to end ─────────────────────────────────────────────
    it("mints for an unknown identifier and the send is accepted", async () => {
      const fresh = `never-seen-${Math.random().toString(36).slice(2, 8)}`;
      const repo = new Repository(db, env.id);
      expect(await repo.getUserByExternalId(fresh)).toBeNull();

      const minted = await devToken(key.credential, { user: fresh });
      expect(minted.status).toBe(200);
      const { token } = (await minted.json()) as { token: string };

      // THE ROW EXISTS NOW, and this is the assertion the requirement is about.
      const created = await repo.getUserByExternalId(fresh);
      expect(created).not.toBeNull();

      // AND THE SEND WORKS. Before this chapter the same sequence answered
      // `400 "unknown user"` — a message naming the caller rather than the cause,
      // which is what implicit creation exists to prevent.
      await repo.addMember(channelId, created!.id);
      const sent = await internalSend(token, channelId, "my first message");
      expect(sent.status).toBe(201);
    });

    // ── T159: one row, whichever arrives first (FR-039b, FR-039c) ────────────
    it("converges on one row whether authentication or membership comes first", async () => {
      const repo = new Repository(db, env.id);
      const viaAuth = `via-auth-${Math.random().toString(36).slice(2, 8)}`;
      const viaMember = `via-member-${Math.random().toString(36).slice(2, 8)}`;

      // Authentication first, then membership.
      await devToken(key.credential, { user: viaAuth });
      const first = await repo.getUserByExternalId(viaAuth);
      await repo.addMember(channelId, first!.id);
      expect((await repo.getUserByExternalId(viaAuth))!.id).toBe(first!.id);

      // Membership first, then authentication — the same row comes back.
      const seeded = await repo.createUser(viaMember, "Seeded By Membership");
      await devToken(key.credential, { user: viaMember });
      const after = await repo.getUserByExternalId(viaMember);
      expect(after!.id).toBe(seeded.id);
      // AND THE DISPLAY NAME SURVIVED. `createUser` is idempotent and does not
      // update — a mint that renamed a user to nothing would be a write nobody asked
      // for, which is the argument that function's own comment makes.
      expect(after!.display_name).toBe("Seeded By Membership");
    });

    it("mints twice for the same identifier and creates one row", async () => {
      const twice = `twice-${Math.random().toString(36).slice(2, 8)}`;
      const repo = new Repository(db, env.id);
      await devToken(key.credential, { user: twice });
      const one = await repo.getUserByExternalId(twice);
      await devToken(key.credential, { user: twice });
      const two = await repo.getUserByExternalId(twice);
      expect(two!.id).toBe(one!.id);
    });

    // ── T160: the status does not say which happened ─────────────────────────
    it("answers identically whether the user existed or not", async () => {
      const repo = new Repository(db, env.id);
      const existing = `existing-${Math.random().toString(36).slice(2, 8)}`;
      await repo.createUser(existing, "Already Here");
      const absent = `absent-${Math.random().toString(36).slice(2, 8)}`;

      const a = await devToken(key.credential, { user: existing });
      const b = await devToken(key.credential, { user: absent });
      expect(a.status).toBe(b.status);
      // The bodies' SHAPES, not their contents — a token and an expiry differ by
      // construction. A status or a field that told the caller which happened would be
      // a membership oracle: mint tokens for guessed ids and read the answer.
      const bodyA = (await a.json()) as Record<string, unknown>;
      const bodyB = (await b.json()) as Record<string, unknown>;
      expect(Object.keys(bodyA).sort()).toEqual(Object.keys(bodyB).sort());
      expect(Object.keys(bodyA).sort()).toEqual(["expires_at", "token"]);
    });

    // ── T161: a mint cannot lift a ban or a deletion ─────────────────────────
    it("does not undo a ban", async () => {
      const repo = new Repository(db, env.id);
      const banned = `banned-${Math.random().toString(36).slice(2, 8)}`;
      const row = await repo.createUser(banned, "Banned");
      await repo.addMember(channelId, row.id);
      await repo.banUser(row.id);

      const minted = await devToken(key.credential, { user: banned });
      expect(minted.status).toBe(200);
      const { token } = (await minted.json()) as { token: string };

      // The mint succeeded and the ban stands: `createUser` touches no column on an
      // existing row, so `banned_at` survives it.
      expect((await repo.getUserByExternalId(banned))!.banned_at).not.toBeNull();
      const refused = await internalSend(token, channelId, "minted past the ban");
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("user_banned");
    });

    it("reuses a deleted user's row without reviving them (FR-030)", async () => {
      const repo = new Repository(db, env.id);
      const gone = `deleted-${Math.random().toString(36).slice(2, 8)}`;
      const row = await repo.createUser(gone, "Deleted");
      await repo.deleteUser(row.id);

      const minted = await devToken(key.credential, { user: gone });
      expect(minted.status).toBe(200);

      const after = await repo.getUserByExternalId(gone);
      // THE SAME ROW, and still deleted. FR-030 says presenting the id again reuses the
      // row; it does not say a MINT undoes a deletion. `POST /v1/users` is the route
      // that clears `deleted_at`, because that is a customer's server saying "this user
      // is back" — a token mint says only "somebody asked for a token".
      expect(after!.id).toBe(row.id);
      expect(after!.deleted_at).not.toBeNull();
    });
  });
});
