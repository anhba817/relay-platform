import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

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
import { parseApiKeyCredential } from "./api-key";
import { resolvePrincipal } from "./authenticate.middleware";
import { MAX_TOKEN_LIFETIME_SECONDS } from "./user-token";

// Chapter 3.8 added `request_id` to every error body (constitution V's fourth
// field, promised since 1.3). It is unique per request BY DESIGN, so two error
// bodies can no longer be compared whole — and comparing them whole is how this
// suite proves a foreign resource is indistinguishable from an absent one, which
// is a tenant-isolation property (constitution I).
//
// The id is the one field that reveals nothing about the resource, so it is the
// one field the comparison must drop. Everything discriminating still has to
// match exactly.
function withoutRequestId(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete rest["request_id"];
  return rest;
}


// The refusals, over real HTTP against the compose Postgres (chapter 3.2).
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
    // Chapter 3.8. This suite submits bad credentials ON PURPOSE — that is what
    // it is for — and the failed-authentication limiter counts them all against
    // one loopback address. The default is ten a minute.
    //
    // RAISING WORKS HOWEVER POLLUTED THE SHARED COUNT, which is why this is a
    // threshold and not a private key: the integration lane runs files in
    // parallel, every suite asserting a `401` lands in the same bucket, and a
    // high ceiling never refuses. A suite needing a LOW threshold needs its own
    // key instead — see `limits.itest.ts` (research R21).
    //
    // Explicit and visible, rather than the default being chosen to suit the
    // tests. Chapter 3.6's `RELAY_DISABLE_SWEEP` states the rule: a flag whose
    // default disabled a requirement would be a requirement nobody had built.
    process.env["RELAY_AUTH_FAILURES_PER_MINUTE"] = "10000";
    // AND ITS OWN BUCKET. Raising the threshold is private to this worker —
    // vitest gives each file its own process — but the Redis key is not, so a
    // suite that raises its ceiling and keeps the default prefix pushes a SHARED
    // count up while being personally immune to it. T004a measured this file's
    // contribution to the default bucket at 8 and signup's at 13, against a
    // threshold of 10: nothing was refused, and only because the suites that
    // spawn a child reach the api over `::ffff:127.0.0.1` while this one reaches
    // it in-process over `::1`. Two address formats were the whole of the
    // isolation. Now it is a prefix, which is a decision rather than an accident.
    process.env["RELAY_AUTH_KEY_PREFIX"] =
      `rlauth-credentials-${Date.now()}`;
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
    // THE SECRET IS EVERYTHING AFTER THE PUBLIC ID, and it is not
    // `split("_").at(-1)`. `api-key.ts` says why three lines from its own regex:
    // "the public id is hex when the secret is base64url … base64url's alphabet
    // INCLUDES the separator". So the secret contains underscores, and taking the
    // last segment yields whatever happens to follow the final one — occasionally
    // a single character, which the row below then contains by chance:
    //
    //     AssertionError: expected '[{"public_id":"9e5240d…' not to contain 'A'
    //
    // Latent since chapter 3.1 and found by chapter 3.11's twenty-run battery on
    // the gate run after it. Parsed with the same shape the production code
    // parses (`CREDENTIAL` in `api-key.ts`) rather than a guess about delimiters.
    const secret = /^rk_(?:dev|live)_[0-9a-f]{32}_(.+)$/.exec(
      minted.credential,
    )![1]!;
    expect(secret.length).toBeGreaterThan(20);

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
    expect(withoutRequestId(await foreignAnswer.json())).toEqual(
      withoutRequestId(await absentAnswer.json()),
    );

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

  // ── T042: the mint's three cases (chapter 3.17, FR-005, FR-005a, SC-006) ──
  //
  // DO NOT ASSERT BYTE-IDENTITY WITH THE UNKNOWN CASE. Everywhere else in this chapter a
  // refusal is made indistinguishable from the refusal for an identifier that exists
  // nowhere — here the unknown case SUCCEEDS, because chapter 3.16 made the mint create
  // the row. There is nothing to be identical to, and any refusal at all says "this
  // identifier exists and is not a person". That is a leak this route cannot close, and
  // saying so is better than an assertion that pretends otherwise.
  it("mints for an unknown identifier and creates it as a PERSON", async () => {
    const fresh = `never-seen-${randomUUID().slice(0, 8)}`;
    const res = await devToken(key.credential, { user: fresh });
    expect(res.status).toBe(200);
    // FR-005a: implicit creation must not produce a bot, or a customer could make one
    // by accident and then find it cannot authenticate.
    const created = await new Repository(db, env.id).getUserByExternalId(fresh);
    expect(created?.kind).toBe("person");
  });

  it("mints for a person who already exists", async () => {
    const repo = new Repository(db, env.id);
    const who = `person-${randomUUID().slice(0, 8)}`;
    await repo.createUser(who, "A Person");
    expect((await devToken(key.credential, { user: who })).status).toBe(200);
  });

  it("refuses a bot with 404 — a bot is not an account", async () => {
    const repo = new Repository(db, env.id);
    const who = `bot-${randomUUID().slice(0, 8)}`;
    await repo.upsertUser(who, { kind: "bot", description: "cannot log in" });
    const res = await devToken(key.credential, { user: who });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
    // FR-005a's other half: the refusal must not have converted anything.
    expect((await repo.getUserByExternalId(who))?.kind).toBe("bot");
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
    // PARSED, not split. `api-key.ts` carries a paragraph explaining that
    // base64url's alphabet includes `_`, so the secret may contain the separator
    // and splitting on it is wrong — and this assertion used to do exactly that:
    // `key.credential.split("_").at(-1)`.
    //
    // It failed the day a mint ended `…_I`, because the assertion had become
    // "no log line contains the letter I" and the error body for a misused key
    // says "this route expects an API key". That was the visible half. The
    // invisible half is worse and was true on most runs: whenever the secret
    // contained an underscore, this checked only the fragment after the LAST
    // one, so a log line leaking the first thirty characters of a secret passed.
    //
    // Found by chapter 3.6's baseline, which ran the lane three times.
    const parsed = parseApiKeyCredential(key.credential);
    expect(parsed).not.toBeNull();
    const secret = parsed!.secret;
    // Guards the guard: a one-character "secret" is how this assertion turned
    // vacuous-then-flaky, and 32 base64url-encoded bytes are never short.
    expect(secret.length).toBeGreaterThan(20);
    expect(haystack).not.toContain(key.credential);
    expect(haystack).not.toContain(secret);
    expect(haystack).not.toContain(foreignKey.credential);
    expect(haystack).not.toContain(parseApiKeyCredential(foreignKey.credential)!.secret);
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

  // --- chapter 3.5: the third principal ----------------------------------

  describe("the internal platform credential", () => {
    // SET, not read. This began as `process.env.RELAY_INTERNAL_CREDENTIAL` with
    // an early return when it was absent — and CI never set it, so the one
    // assertion standing between a platform credential and a public route
    // silently did nothing on every build. A security test that skips itself is
    // worse than no test: it reports green about a question it never asked.
    const PLATFORM = "rk_svc_credentials_itest_0123456789abcdef01234";
    process.env["RELAY_INTERNAL_CREDENTIAL"] = PLATFORM;

    it("is refused on a public route, whatever else it can do", async () => {

      // The whole point of the kind. It reaches every environment, so a public
      // route accepting it would be a cross-tenant hole with a valid credential
      // in front of it. 403 `wrong_credential_type` — the route's default is
      // application-or-user, and platform is neither.
      const res = await post({ text: "should never land" }, PLATFORM);

      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("wrong_credential_type");
      // And it must not quote the credential back (NFR-SEC-06).
      expect(JSON.stringify(body)).not.toContain(PLATFORM);
    });
  });

  // --- chapter 3.11: one credential per service ---------------------------

  describe("which service presented it", () => {
    // SET, not read, for the reason the block above gives.
    const DISPATCHER = "rk_svc_credentials_itest_0123456789abcdef01234";
    const GATEWAY = "rk_svc_gateway_itest_fedcba98765432100fedcba9";
    process.env["RELAY_INTERNAL_CREDENTIAL"] = DISPATCHER;
    process.env["RELAY_INTERNAL_CREDENTIAL_GATEWAY"] = GATEWAY;

    it("names the dispatcher for the dispatcher's secret", async () => {
      expect(await resolvePrincipal(db, DISPATCHER)).toEqual({
        kind: "platform",
        service: "dispatcher",
      });
    });

    it("names the GATEWAY for the gateway's secret", async () => {
      // Until this chapter `resolvePlatformCredential` ended with a hardcoded
      // `service: "dispatcher"`, which was true while there was one caller and
      // became a lie the moment there were two. `PlatformPrincipal.service` is
      // documented as "which internal service presented it, for logs".
      expect(await resolvePrincipal(db, GATEWAY)).toEqual({
        kind: "platform",
        service: "gateway",
      });
    });

    it("gives neither service the other's reach", async () => {
      // The property beyond honest logs: the gateway terminates public traffic
      // and the dispatcher does not, so one shared secret would let the more
      // exposed service set the blast radius for both.
      expect(DISPATCHER).not.toBe(GATEWAY);
      const swapped = await resolvePrincipal(db, GATEWAY);
      expect(swapped).not.toBeNull();
      expect((swapped as { service: string }).service).not.toBe("dispatcher");
    });

    it("refuses a secret shorter than 32 characters, per service", async () => {
      // A short secret is a misconfiguration, and the safe reading of one is
      // "this service cannot authenticate" rather than "this service is open".
      const short = "rk_svc_tooshort";
      process.env["RELAY_INTERNAL_CREDENTIAL_GATEWAY"] = short;
      expect(await resolvePrincipal(db, short)).toBeNull();
      process.env["RELAY_INTERNAL_CREDENTIAL_GATEWAY"] = GATEWAY;
    });

    it("makes an unconfigured service unusable rather than universal", async () => {
      delete process.env["RELAY_INTERNAL_CREDENTIAL_GATEWAY"];
      expect(await resolvePrincipal(db, GATEWAY)).toBeNull();
      // The dispatcher is untouched by its neighbour's absence.
      expect(await resolvePrincipal(db, DISPATCHER)).not.toBeNull();
      process.env["RELAY_INTERNAL_CREDENTIAL_GATEWAY"] = GATEWAY;
    });

    it("refuses a well-formed secret that matches nobody", async () => {
      expect(
        await resolvePrincipal(db, "rk_svc_nobodys_secret_0000000000000000000"),
      ).toBeNull();
    });
  });

  // ══ FR-USR-02: A USER ROW ON FIRST AUTHENTICATION (chapter 3.15) ════════════
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
