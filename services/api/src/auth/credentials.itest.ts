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
import { parseApiKeyCredential } from "./api-key";
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
    const secret = minted.credential.split("_").at(-1)!;

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
});
