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

const PLATFORM = "rk_svc_usage_itest_0123456789abcdef012345";
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
    process.env["RELAY_INTERNAL_CREDENTIAL"] = PLATFORM;

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

  describe("who may write a bill (FR-011, SC-010)", () => {
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

  describe("the schema is the door (FR-011)", () => {
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
});
