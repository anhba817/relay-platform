import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { mintUserToken } from "../auth/user-token";
import { createDb, createPool, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { retentionDaysOf } from "../db/retention-reads";

// CHAPTER 4.20 — `PATCH /v1/environments/{id}`, FR-MOD-06's only write.
//
// A REPOSITORY TEST PROVES A CHECK EXISTS AND ONLY A ROUTE TEST PROVES IT FIRES, which
// is why this file boots a Nest app rather than calling `setRetentionPolicy`.
/** A refusal body without the field that is supposed to differ.
 *
 * DESTRUCTURE-AND-REST WOULD BIND AN UNUSED NAME and this workspace's lint refuses one
 * — there is no `varsIgnorePattern`, so even `_ignored` is an error rather than a
 * convention. Deleting the key says the same thing and binds nothing. */
const withoutRequestId = (body: unknown): Record<string, unknown> => {
  const rest = { ...(body as Record<string, unknown>) };
  delete rest["request_id"];
  return rest;
};

describe("PATCH /v1/environments/:environmentId", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let environmentId: string;
  let credential: string;
  let userToken: string;

  const patch = (
    id: string,
    body: unknown,
    token = credential,
  ): Promise<Response> =>
    fetch(`${url}/v1/environments/${id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const pool = createPool();
    await migrate(pool);
    db = createDb(pool);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();

    const env = await createEnvironment(db, { name: "env-route" });
    environmentId = env.id;
    ({ credential } = await createApiKey(db, { environmentId }));

    const repo = new Repository(db, environmentId, {
      kind: "application",
      id: "env-route-suite",
      requestId: crypto.randomUUID(),
    });
    await repo.createUser("env-route-user", "User");
    const secret = (await environmentSigningSecret(db, environmentId))!.signingSecret;
    userToken = (
      await mintUserToken(secret, {
        user: "env-route-user",
        environmentId,
        ttlSeconds: 3600,
      })
    ).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it("sets each of the clause's three values, and reports what it set", async () => {
    for (const days of [30, 90, 365] as const) {
      const res = await patch(environmentId, { retention_days: days });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ retention_days: days });
      expect(await retentionDaysOf(db, environmentId)).toBe(days);
    }
  });

  it("`null` is indefinite and clears the policy", async () => {
    await patch(environmentId, { retention_days: 90 });
    const res = await patch(environmentId, { retention_days: null });

    expect(res.status).toBe(200);
    expect(await retentionDaysOf(db, environmentId)).toBeNull();
  });

  it("an OMITTED field is a different request from an explicit null", async () => {
    // FR-MOD-06's fourth option is *indefinite* and this column has spelled that as an
    // absent value since chapter 2.1 — so a body that mentions nothing must not be read
    // as asking for it. Chapter 4.14's lesson: an absent key and a null value are the
    // same to a truthiness check and different to a contract.
    await patch(environmentId, { retention_days: 365 });
    const res = await patch(environmentId, {});

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
    expect(await retentionDaysOf(db, environmentId)).toBe(365);
  });

  it("refuses a value the clause does not offer", async () => {
    const res = await patch(environmentId, { retention_days: 45 });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
  });

  it("refuses an UNKNOWN FIELD rather than ignoring it (constitution VI)", async () => {
    // *"Input is validated against a schema before processing; unknown fields are
    // rejected on write endpoints"* is a MUST, and a `z.object` would have taken this
    // body and applied the half it recognised. `z.strictObject` is what makes the
    // refusal happen, and this is the test that says the schema is strict — reading
    // `strictObject` in the source is not the same claim.
    const res = await patch(environmentId, {
      retention_days: 30,
      retentionDays: 365,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_request" });
  });

  it("refuses a user token with wrong_credential_type", async () => {
    // THE DECORATOR IS THE DECISION. `@Accepts("application")` is class-level, and
    // without it `CredentialGuard` falls back to EITHER — so an end-user signed into
    // the customer's product could set a thirty-day policy and destroy the tenant's
    // history. Chapter 4.18 measured the same decorator's absence on a READ route at
    // 200 with the whole moderation log.
    const res = await patch(environmentId, { retention_days: 30 }, userToken);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "wrong_credential_type" });
  });

  it("answers 404 for another tenant's environment, like one that does not exist", async () => {
    const other = await createEnvironment(db, { name: "env-route-other" });

    const foreign = await patch(other.id, { retention_days: 30 });
    const absent = await patch("00000000-0000-4000-8000-000000000000", {
      retention_days: 30,
    });

    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    // INDISTINGUISHABLE, which is the point: a refusal that named the cause would
    // report whether somebody else's environment exists.
    //
    // `request_id` IS THE ONE FIELD THAT MUST DIFFER, which is why it comes out before
    // the comparison rather than being allowed to weaken it — chapter 4.11 drew the
    // same line for media objects, where three distinct refusals return byte-identical
    // bodies apart from that field. `withoutRequestId` is `isolation/compare.ts`'s and
    // this file re-derives it rather than importing a helper out of that directory.
    expect(withoutRequestId(await foreign.json())).toEqual(
      withoutRequestId(await absent.json()),
    );
    expect(await retentionDaysOf(db, other.id)).toBeNull();
  });
});
