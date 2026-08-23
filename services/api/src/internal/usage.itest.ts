import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  usageFor,
} from "../db/repository";
import { mintUserToken } from "../auth/user-token";

// `POST /internal/usage/connections` — who may reach it, and what a refusal
// leaves behind (chapter 3.11).
//
// THE ISOLATION QUESTION HERE IS DIFFERENT IN KIND, and constitution I still
// asks it. Every endpoint this series has added carries a test that presents
// another tenant's id and gets nothing. This one cannot: a platform credential
// has no environment by construction, and naming environments in the body is the
// whole point of the route. So the property splits in two, and both halves are
// testable —
//
//   1. no tenant credential can reach it at all, and
//   2. no connection can change environment once its row exists.
//
// What is deliberately NOT prevented is a platform caller writing usage for any
// environment. That is what a platform credential is; chapter 3.5 argued it, and
// the protection is that the credential is deployment configuration rather than
// tenant data — never provisioned, never in a table, absent by default.
//
// Chapter 3.5 added the first platform-credentialled routes and left no
// `dispatch.itest.ts` in this directory at all. The precedent was silence, and
// silence about an isolation property is what constitution I calls a
// configuration mistake.

// THE GATEWAY'S CREDENTIAL, and chapter 3.12 is why the variable changed.
//
// This suite set `RELAY_INTERNAL_CREDENTIAL` — the DISPATCHER's variable — and
// presented it to `POST /internal/usage/connections`, which is the gateway's route
// and nothing else's. It passed, because until FR-044 a route could say which class
// of credential may call it and not which service, so both platform credentials
// were interchangeable everywhere. The suite verifying the gateway's metering route
// had never used the gateway's credential, and nine of its tests turned 403 the
// moment the route declared its service.
//
// That is the hole FR-044 closes, demonstrated by this file rather than argued for.
const PLATFORM = "rk_svc_usage_itest_0123456789abcdef012345";
/** The dispatcher's, kept so the refusal can be tested in both directions (T030e). */
const DISPATCHER_CREDENTIAL = "rk_svc_usage_itest_dispatcher_0123456789";
const AUGUST = "2026-08-01";

describe("POST /internal/usage/connections", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let environmentId: string;
  let otherEnvironmentId: string;
  let apiKey: string;
  let userToken: string;

  beforeAll(async () => {
    // SET, not read — `credentials.itest.ts` explains why at length: CI never
    // set it, and the assertion standing between a platform credential and a
    // public route silently did nothing on every build.
    process.env["RELAY_INTERNAL_CREDENTIAL_GATEWAY"] = PLATFORM;
    process.env["RELAY_INTERNAL_CREDENTIAL"] = DISPATCHER_CREDENTIAL;

    db = createDb(createPool());
    const env = await createEnvironment(db, { name: `usage-itest-${randomUUID()}` });
    environmentId = env.id;
    const other = await createEnvironment(db, {
      name: `usage-itest-other-${randomUUID()}`,
    });
    otherEnvironmentId = other.id;

    apiKey = (await createApiKey(db, { environmentId })).credential;
    const secret = (await environmentSigningSecret(db, environmentId))!
      .signingSecret;
    userToken = (
      await mintUserToken(secret, {
        user: "tuan",
        environmentId,
        ttlSeconds: 3600,
      })
    ).token;

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  const post = (body: unknown, credential?: string) =>
    fetch(`${url}/internal/usage/connections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const oneReport = (minutes: number, environment = environmentId) => ({
    connections: [
      {
        connection_id: randomUUID(),
        environment_id: environment,
        period: AUGUST,
        minutes,
      },
    ],
  });

  const minutes = async (environment = environmentId) =>
    (await usageFor(db, environment, AUGUST)).connectionMinutes;

  describe("who may write a bill (NFR-SEC-06)", () => {
    it("accepts the platform credential and says what it credited", async () => {
      const res = await post(oneReport(6), PLATFORM);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ credited: 6 });
    });

    it("refuses no credential with 401, and changes nothing", async () => {
      const before = await minutes();
      const res = await post(oneReport(999_999), undefined);
      expect(res.status).toBe(401);
      expect(await minutes()).toBe(before);
    });

    it("refuses a valid API KEY with 403, and changes nothing", async () => {
      // A perfectly good credential of the wrong class. This is the half that
      // stops a customer writing usage — for anybody, including themselves.
      const before = await minutes();
      const res = await post(oneReport(999_999), apiKey);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("wrong_credential_type");
      expect(await minutes()).toBe(before);
    });

    it("refuses a valid END-USER TOKEN with 403, and changes nothing", async () => {
      const before = await minutes();
      const res = await post(oneReport(999_999), userToken);
      expect(res.status).toBe(403);
      expect(await minutes()).toBe(before);
    });

    it("never quotes the credential back (NFR-SEC-06)", async () => {
      const body = await (await post(oneReport(1), apiKey)).text();
      expect(body).not.toContain(apiKey);
      expect(body).not.toContain(PLATFORM);
    });
  });

  // ── FR-044: a platform credential is authorized by SERVICE, not just by class ──
  //
  // Until this chapter `Accepts` took kinds, both platform credentials resolved to
  // one class, and every `@Accepts("platform")` route accepted either. So the
  // gateway's credential reached `POST /internal/dispatch/replay`, whose handler
  // takes a dead-letter id and NO environment — it acts on any tenant's dead
  // letter, which is correct for the dispatcher and is reach the gateway should
  // never have had. Chapter 3.11 argued for two secrets on exactly this ground
  // ("the gateway terminates connections from the public internet and the
  // dispatcher does not") and stopped one step short: two secrets stopped them
  // sharing a secret, and they still shared a surface.
  //
  // BOTH DIRECTIONS, ROUTE BY ROUTE. A rule tested one way is a rule that works
  // one way.
  describe("a platform credential is refused on another service's route (FR-044)", () => {
    const DISPATCH_ROUTES = [
      "/internal/dispatch/expand",
      "/internal/dispatch/material",
      "/internal/dispatch/outcome",
      "/internal/dispatch/replay",
    ] as const;

    it.each(DISPATCH_ROUTES)(
      "refuses the gateway's credential on %s",
      async (route) => {
        const res = await fetch(`${url}${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${PLATFORM}`,
          },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { code: string; message: string };
        expect(body.code).toBe("wrong_credential_service");
        // T030c2: the message names the service and the permitted set, and never
        // the credential. A service name is a deployment label; a credential is a
        // secret (NFR-SEC-06).
        expect(body.message).toContain('"gateway"');
        expect(body.message).toContain("dispatcher");
        expect(body.message).not.toContain(PLATFORM);
      },
    );

    it("refuses the dispatcher's credential on the gateway's metering route", async () => {
      const res = await fetch(`${url}/internal/usage/connections`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${DISPATCHER_CREDENTIAL}`,
        },
        body: JSON.stringify(oneReport(1)),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("wrong_credential_service");
      expect(body.message).toContain('"dispatcher"');
      expect(body.message).toContain("gateway");
      expect(body.message).not.toContain(DISPATCHER_CREDENTIAL);
    });

    it("still accepts the gateway's credential on the gateway's own route", async () => {
      // The other half of a refusal test: a rule that refuses everything passes
      // the same assertions as a rule that refuses the right thing.
      const res = await post(oneReport(2), PLATFORM);
      expect(res.status).toBe(200);
    });
  });

  describe("a connection does not move between tenants (FR-TEN-05)", () => {
    it("refuses a second environment for a connection that already has one", async () => {
      const connection = randomUUID();
      const first = await post(
        { connections: [{ connection_id: connection, environment_id: environmentId, period: AUGUST, minutes: 3 }] },
        PLATFORM,
      );
      expect(first.status).toBe(200);

      const before = await minutes(otherEnvironmentId);
      const stolen = await post(
        { connections: [{ connection_id: connection, environment_id: otherEnvironmentId, period: AUGUST, minutes: 90 }] },
        PLATFORM,
      );

      expect(stolen.status).toBe(409);
      expect((await stolen.json()).code).toBe("connection_environment_conflict");
      expect(await minutes(otherEnvironmentId)).toBe(before);
    });

    it("rolls the whole batch back when one entry conflicts", async () => {
      // The credit runs in one transaction, so a batch that contains a stolen
      // connection credits none of its neighbours either. Partial application is
      // a state the caller would have to reason about, and it does not exist.
      const stolen = randomUUID();
      await post(
        { connections: [{ connection_id: stolen, environment_id: environmentId, period: AUGUST, minutes: 2 }] },
        PLATFORM,
      );

      const before = await minutes(otherEnvironmentId);
      const res = await post(
        {
          connections: [
            { connection_id: randomUUID(), environment_id: otherEnvironmentId, period: AUGUST, minutes: 5 },
            { connection_id: stolen, environment_id: otherEnvironmentId, period: AUGUST, minutes: 5 },
          ],
        },
        PLATFORM,
      );

      expect(res.status).toBe(409);
      expect(await minutes(otherEnvironmentId)).toBe(before);
    });
  });

  describe("the schema is the door (NFR-SEC-06)", () => {
    it("refuses a period that is not the first of a month", async () => {
      const res = await post(
        { connections: [{ connection_id: randomUUID(), environment_id: environmentId, period: "2026-08-14", minutes: 1 }] },
        PLATFORM,
      );
      expect(res.status).toBe(400);
    });

    it("refuses a negative total", async () => {
      const res = await post(oneReport(-1), PLATFORM);
      expect(res.status).toBe(400);
    });

    it("refuses an empty batch", async () => {
      const res = await post({ connections: [] }, PLATFORM);
      expect(res.status).toBe(400);
    });

    it("does not quietly credit an environment that does not exist", async () => {
      // A well-formed uuid naming nothing. The foreign key refuses it, the
      // controller does NOT recognise that as a conflict, and it rethrows —
      // which is the branch that separates "this connection moved tenants" from
      // "something else went wrong". Swallowing the second as the first would
      // turn a broken caller into a 409 nobody investigates.
      const res = await post(oneReport(3, randomUUID()), PLATFORM);
      expect(res.status).toBe(500);
      expect((await res.json()).code).toBe("internal_error");
    });
  });

  describe("the api's half of the refusal (US3, FR-RTL-08)", () => {
    const setCap = (config: unknown) =>
      db
        ? fetch(`${url}/healthz`).then(async () => {
            const { createPool } = await import("../db/client.js");
            const p = createPool();
            await p.query(
              "UPDATE environments SET quota_config = $1 WHERE id = $2",
              [JSON.stringify(config), environmentId],
            );
            await p.end();
          })
        : Promise.resolve();

    const session = (credential: string) =>
      fetch(`${url}/internal/session`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}` },
      });

    it("answers 402 with a named code when the cap is spent", async () => {
      await setCap({ connection_minutes: { hard: 1 } });
      await post(oneReport(50), PLATFORM);

      const res = await session(userToken);
      expect(res.status).toBe(402);

      const body = (await res.json()) as Record<string, string>;
      // NAMED BY THE THROWER. `ProtocolErrorFilter` infers a code for four
      // statuses and 402 is not one of them, so an unnamed refusal would arrive
      // as `internal_error` — chapter 3.10's H3.
      expect(body.code).toBe("quota_exceeded");
      expect(body.message).toContain("connection-minute");
      expect(body.message).toContain("connections resume on");
      // Four fields, as every refusal on this contract has since chapter 3.8.
      expect(body.docs_url).toBeTruthy();
      expect(body.request_id).toBeTruthy();
    });

    it("carries NO Retry-After, which is the whole difference from a rate limit", async () => {
      await setCap({ connection_minutes: { hard: 1 } });
      const res = await session(userToken);
      expect(res.status).toBe(402);
      // A client that sleeps for a header and retries is right for a rate limit
      // and wrong for a quota, which will still be exhausted in an hour.
      expect(res.headers.get("retry-after")).toBeNull();
    });

    it("answers 200 again the moment the cap is raised", async () => {
      await setCap({ connection_minutes: { hard: 100_000 } });
      const res = await session(userToken);
      expect(res.status).toBe(200);
    });

    it("answers 200 with no cap configured", async () => {
      await setCap({});
      expect((await session(userToken)).status).toBe(200);
    });
  });
});