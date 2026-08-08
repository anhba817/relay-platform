import "reflect-metadata";

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool } from "../db/client";
import { provisionOrganisation, Repository } from "../db/repository";
import { STATE_COOKIE } from "./state-cookie";

// Signup against the real database (chapter 3.1) — invariants 1–4 and 7.
//
// The OAuth provider is a stand-in served from this file: a token endpoint and
// a user endpoint, on a real port. Nothing about the flow is stubbed except who
// answers it, which is what keeps this lane offline and deterministic while
// still exercising the same code path a reader points at GitHub (research R8).

/** A provider that answers exactly what the test tells it to. */
function standInProvider(profile: unknown, tokenBody?: unknown) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/token")) {
      res.end(JSON.stringify(tokenBody ?? { access_token: "gho_test" }));
      return;
    }
    res.end(JSON.stringify(profile));
  });
  return new Promise<{ port: number; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          port,
          close: () => new Promise<void>((done) => server.close(() => done())),
        });
      });
    },
  );
}

describe("signup", () => {
  let app: INestApplication;
  let url: string;
  let db: ReturnType<typeof createDb>;
  let provider: Awaited<ReturnType<typeof standInProvider>>;

  beforeAll(async () => {
    db = createDb(createPool());
    provider = await standInProvider({
      id: 90210,
      login: "tuan",
      name: "Tuan",
    });
    // The provider's endpoints are configuration, so pointing them at the
    // stand-in is all the wiring this needs.
    process.env.RELAY_OAUTH_GITHUB_CLIENT_ID = "test-client";
    process.env.RELAY_OAUTH_GITHUB_CLIENT_SECRET = "test-secret";
    process.env.RELAY_OAUTH_GITHUB_TOKEN_URL = `http://127.0.0.1:${provider.port}/token`;
    process.env.RELAY_OAUTH_GITHUB_USER_URL = `http://127.0.0.1:${provider.port}/user`;
    process.env.RELAY_OAUTH_GITHUB_AUTHORIZE_URL = `http://127.0.0.1:${provider.port}/authorize`;
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await provider.close();
  });

  /** Walk the flow the way a browser would: start, keep the cookie, come back
   * with the state the server minted. */
  async function signUp(code = "code-1") {
    const start = await fetch(`${url}/auth/github/start`, {
      redirect: "manual",
    });
    const setCookie = start.headers.get("set-cookie") ?? "";
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const cookie = setCookie.split(";")[0]!;
    const res = await fetch(
      `${url}/auth/github/callback?code=${code}&state=${state}`,
      { headers: { cookie } },
    );
    return {
      status: res.status,
      body: (await res.json()) as {
        organisation: { id: string; name: string };
        application: { id: string; name: string };
        environment: { id: string; kind: string };
        created: boolean;
      },
    };
  }

  /** Run a block against a provider that reports a fresh identity. Signup is
   * idempotent PER IDENTITY, so a test that wants to observe a first signup
   * needs an identity no earlier test has used — otherwise it is asserting
   * against the suite's history rather than the behaviour. */
  async function withFreshIdentity<T>(
    accountId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const fresh = await standInProvider({
      id: accountId,
      login: `u-${accountId}`,
    });
    const tokenUrl = process.env.RELAY_OAUTH_GITHUB_TOKEN_URL;
    const userUrl = process.env.RELAY_OAUTH_GITHUB_USER_URL;
    process.env.RELAY_OAUTH_GITHUB_TOKEN_URL = `http://127.0.0.1:${fresh.port}/token`;
    process.env.RELAY_OAUTH_GITHUB_USER_URL = `http://127.0.0.1:${fresh.port}/user`;
    try {
      return await fn();
    } finally {
      process.env.RELAY_OAUTH_GITHUB_TOKEN_URL = tokenUrl;
      process.env.RELAY_OAUTH_GITHUB_USER_URL = userUrl;
      await fresh.close();
    }
  }

  it("provisions the whole trio from one authentication (FR-TEN-01, FR-TEN-02)", async () => {
    const { status, body } = await withFreshIdentity(`trio-${Date.now()}`, () =>
      signUp(),
    );
    expect(status).toBe(200);
    expect(body.created).toBe(true);
    expect(body.organisation.id).toBeTruthy();
    expect(body.application.id).toBeTruthy();
    // FR-TEN-02 names the kind: development, and only development.
    expect(body.environment.kind).toBe("development");

    // Five rows, and the fifth is the one that says who owns it.
    const rows = await db.execute(
      `SELECT
         (SELECT count(*) FROM organisations WHERE id = '${body.organisation.id}') AS orgs,
         (SELECT count(*) FROM applications WHERE organisation_id = '${body.organisation.id}') AS apps,
         (SELECT count(*) FROM environments WHERE application_id = '${body.application.id}') AS envs,
         (SELECT count(*) FROM memberships WHERE organisation_id = '${body.organisation.id}' AND role = 'owner') AS owners`,
    );
    const counts = rows.rows[0] as Record<string, string>;
    expect(Number(counts.orgs)).toBe(1);
    expect(Number(counts.apps)).toBe(1);
    expect(Number(counts.envs)).toBe(1);
    expect(Number(counts.owners)).toBe(1);
  });

  it("writes the full set or nothing when provisioning fails (invariant 1)", async () => {
    // Force a failure inside the transaction, after the organisation insert:
    // an organisation name that is fine and a provider value the CHECK
    // constraint refuses.
    await expect(
      provisionOrganisation(db, {
        provider: "not-a-provider",
        providerAccountId: "x",
        organisationName: "doomed org",
      }),
    ).rejects.toThrow();
    // REVISED by chapter 3.3: this used to count ALL organisations before and
    // after and assert the totals matched. That is a global assertion in a lane
    // where other suites create tenants concurrently — it passed for two
    // chapters and then failed with "expected 884 to be 883" the day 3.3's
    // crash tests started spawning child processes that provision their own.
    // The precise assertion below was always the one carrying the weight: the
    // doomed organisation must not survive its transaction. A count of
    // everything was never evidence about this rollback.
    const orphan = await db.execute(
      `SELECT count(*)::int AS n FROM organisations WHERE name = 'doomed org'`,
    );
    expect((orphan.rows[0] as { n: number }).n).toBe(0);
  });

  it("recognises a returning owner instead of creating a second organisation (invariant 2)", async () => {
    const accountId = `returning-${Date.now()}`;
    const { first, second } = await withFreshIdentity(accountId, async () => ({
      first: await signUp("code-a"),
      second: await signUp("code-b"),
    }));
    expect(first.body.created).toBe(true);
    expect(second.body.created).toBe(false);
    expect(second.body.organisation.id).toBe(first.body.organisation.id);
    expect(second.body.environment.id).toBe(first.body.environment.id);
    // One human, one owned organisation — the unique index decided, not a
    // read-then-write check.
    const owned = await db.execute(
      `SELECT count(*)::int AS n FROM memberships m
         JOIN humans h ON h.id = m.human_id
        WHERE h.provider_account_id = '${accountId}' AND m.role = 'owner'`,
    );
    expect((owned.rows[0] as { n: number }).n).toBe(1);
  });

  it("refuses a third environment for one application (invariant 3, FR-TEN-04)", async () => {
    // Its own identity, so its own application: this test adds a production
    // environment, and the database is not truncated between runs — reusing a
    // shared identity would hand the second run an application that already
    // had one (the per-suite-environment lesson from 2.1, one level up).
    const { body } = await withFreshIdentity(`envcap-${Date.now()}`, () =>
      signUp("code-c"),
    );
    const appId = body.application.id;
    // Production is legal — two environments are what FR-TEN-04 allows.
    await db.execute(
      `INSERT INTO environments (id, application_id, kind, signing_secret)
       VALUES (gen_random_uuid(), '${appId}', 'production', gen_random_uuid())`,
    );
    // A second development environment is not, and the database is what says
    // so — no application-level guard to lose a race to.
    await expect(
      db.execute(
        `INSERT INTO environments (id, application_id, kind, signing_secret)
         VALUES (gen_random_uuid(), '${appId}', 'development', gen_random_uuid())`,
      ),
    ).rejects.toThrow();
    const kinds = await db.execute(
      `SELECT count(*)::int AS n FROM environments WHERE application_id = '${appId}'`,
    );
    expect((kinds.rows[0] as { n: number }).n).toBe(2);
  });

  it("keeps two organisations blind to each other (invariant 4, FR-TEN-05)", async () => {
    // Two tenants, each with a message of its own.
    const a = await provisionOrganisation(db, {
      provider: "github",
      providerAccountId: `iso-a-${Date.now()}`,
      organisationName: "org a",
    });
    const b = await provisionOrganisation(db, {
      provider: "github",
      providerAccountId: `iso-b-${Date.now()}`,
      organisationName: "org b",
    });
    const repoA = new Repository(db, a.environment.id);
    const repoB = new Repository(db, b.environment.id);
    const userA = await repoA.createUser("a-user");
    const channelA = await repoA.createChannel("a-channel", "public");
    await repoA.addMember(channelA.id, userA.id);
    await repoA.sendMessage(channelA.id, {
      text: "a secret",
      userId: userA.id,
    });

    // B asks for A's channel by id and gets nothing — not an error that would
    // confirm it exists (FR-TEN-05).
    expect(await repoB.listMessages(channelA.id, { limit: 10 })).toEqual([]);
    expect(await repoB.getChannelByExternalId("a-channel")).toBeNull();
    expect(await repoB.listChannels()).toEqual([]);
    // And A still sees its own.
    expect((await repoA.listMessages(channelA.id, { limit: 10 })).length).toBe(
      1,
    );
  });

  it("exposes provisioning nowhere but the signup path (invariant 7, spec FR-011)", async () => {
    // The admin surface is a module-free function: it is not a provider, so no
    // controller can be handed it by injection, and the tenancy module declares
    // no providers at all. What a reader can check from outside is that no
    // route creates a tenant on request.
    for (const path of [
      "/v1/channels/00000000-0000-0000-0000-000000000000/messages",
      "/internal/memberships",
      "/internal/backfill",
    ]) {
      const res = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      // Whatever these answer, it is never "here is a new tenant".
      expect(res.status).not.toBe(200);
      const text = await res.text();
      expect(text).not.toContain("organisation");
    }
    const before = await db.execute(
      `SELECT count(*)::int AS n FROM organisations`,
    );
    // Chapter 3.2: there is no header left to forge here. The assertion is
    // unchanged — no route but signup creates a tenant — and a credential-free
    // internal call is now refused before it reaches a handler, which is a
    // stronger form of the same guarantee.
    await fetch(`${url}/internal/memberships`);
    const after = await db.execute(
      `SELECT count(*)::int AS n FROM organisations`,
    );
    expect((after.rows[0] as { n: number }).n).toBe(
      (before.rows[0] as { n: number }).n,
    );
  });

  it("refuses a callback whose state does not match the cookie (invariant 5, over HTTP)", async () => {
    const start = await fetch(`${url}/auth/github/start`, {
      redirect: "manual",
    });
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
    // An attacker's state value with the victim's cookie: refused.
    const res = await fetch(
      `${url}/auth/github/callback?code=c&state=deadbeefdeadbeefdeadbeefdeadbeef`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
    // And with no cookie at all.
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const naked = await fetch(
      `${url}/auth/github/callback?code=c&state=${state}`,
    );
    expect(naked.status).toBe(400);
    expect(cookie).toContain(STATE_COOKIE);
  });

  it("answers 502 when the provider breaks its contract (invariant 6, over HTTP)", async () => {
    const broken = await standInProvider({ login: "no-id-here" });
    process.env.RELAY_OAUTH_GITHUB_USER_URL = `http://127.0.0.1:${broken.port}/user`;
    process.env.RELAY_OAUTH_GITHUB_TOKEN_URL = `http://127.0.0.1:${broken.port}/token`;
    const start = await fetch(`${url}/auth/github/start`, {
      redirect: "manual",
    });
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const res = await fetch(
      `${url}/auth/github/callback?code=c&state=${state}`,
      { headers: { cookie } },
    );
    // 502, not 400: the caller did nothing wrong.
    expect(res.status).toBe(502);
    await broken.close();
    process.env.RELAY_OAUTH_GITHUB_USER_URL = `http://127.0.0.1:${provider.port}/user`;
    process.env.RELAY_OAUTH_GITHUB_TOKEN_URL = `http://127.0.0.1:${provider.port}/token`;
  });
});
