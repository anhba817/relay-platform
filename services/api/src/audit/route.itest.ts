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
import { actorFrom } from "./actor";
import { ACTION } from "./moderation-routes";

// FR-MOD-03's ROUTE OVER REAL HTTP, separate from `audit.itest.ts`, which owns the write
// side and the reader. `request-log/route.itest.ts` drew this line one chapter over and
// the reason transfers: what only a route can show is the guard's decision, the
// validation pipe's refusals and the envelope a client actually receives.
//
// AND THIS FILE EXISTS BECAUSE OF T046's THIRD ARM. The controller's
// `environmentId === undefined` -> 403 was deleted and **nothing went red** — 22 of 22
// and the gauntlet 62 of 62. The branch is unreachable: `@Accepts("application")` makes
// `CredentialGuard` refuse a platform principal with `wrong_credential_type` before the
// handler runs, and an application principal always resolves to an environment.
//
// **The branch defends against a case that cannot arise, and the case that would
// actually be bad was untested.** Drop the decorator and the guard falls back to
// `EITHER`; a USER principal has an `environmentId`, so that branch would not fire and
// every person signed into a customer's product could read that customer's whole
// moderation history. The decorator is the decision and the test below is the evidence
// it is there.

describe("GET /v1/audit-log", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let environmentId: string;
  let credential: string;
  /** A token for a person signed into the tenant's product. The route must refuse it. */
  let userToken: string;

  const get = (query: string, token = credential): Promise<Response> =>
    fetch(`${url}/v1/audit-log${query}`, {
      headers: { authorization: `Bearer ${token}` },
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

    const env = await createEnvironment(db, { name: "audit-route" });
    environmentId = env.id;
    ({ credential } = await createApiKey(db, { environmentId }));

    const secret = (await environmentSigningSecret(db, environmentId))!.signingSecret;
    const bootstrap = new Repository(db, environmentId, {
      kind: "application",
      id: "route-suite",
      requestId: crypto.randomUUID(),
    });
    await bootstrap.createUser("log-reader", "Log Reader");
    userToken = (
      await mintUserToken(secret, {
        user: "log-reader",
        environmentId,
        ttlSeconds: 3600,
      })
    ).token;

    // ONE ENTRY, SO A 200 HAS SOMETHING IN IT — and written through the product rather
    // than planted, because an empty page passes every assertion below for the wrong
    // reason. A ban is the cheapest moderation action that produces one.
    const subject = await bootstrap.createUser("route-subject", "Subject");
    await bootstrap.banUser(subject.id);
  });

  afterAll(async () => {
    // NOTHING IS DELETED. The table refuses `DELETE` to the application, which is the
    // chapter's subject — and the rows are scoped to an environment this suite minted,
    // which is `fixtures.ts`'s standing convention for the same reason.
    await app.close();
  });

  it("answers a tenant's own application credential, with the envelope EIR-API-06 names", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { action: string; target: { id: string } }[];
      has_more: boolean;
      next_cursor: string | null;
      prev_cursor: string | null;
      window: { from: string; to: string };
    };
    expect(body.entries.map((e) => [e.action, e.target.id])).toContainEqual([
      ACTION.ban,
      "route-subject",
    ]);
    // THE FIELDS BY NAME, because `has_more` is the clause this platform was
    // non-conforming with until chapter 4.8 and a second list route shipping without it
    // would have joined `messages.service.ts` on that list.
    expect(body).toHaveProperty("has_more");
    expect(body).toHaveProperty("next_cursor");
    expect(body).toHaveProperty("prev_cursor");
    expect(Object.keys(body.window).sort()).toEqual(["from", "to"]);
    // AND NOT `retention_edge`, which is the precedent's one field this route drops:
    // nothing prunes this table, so publishing a boundary would announce a guarantee the
    // platform does not enforce.
    expect(body).not.toHaveProperty("retention_edge");
  });

  it("refuses an end-user token: a person in the product is not the product", async () => {
    // T046's ARM 3. The controller's own 403 is unreachable; THIS is what keeps a
    // tenant's moderation history out of its end users' hands, and before this test
    // nothing in the repository said the decorator was there.
    const res = await get("", userToken);
    expect(res.status).toBe(403);
    expect((await res.json() as Record<string, unknown>)["code"]).toBe(
      "wrong_credential_type",
    );
  });

  it("refuses no credential at all", async () => {
    const res = await fetch(`${url}/v1/audit-log`);
    expect(res.status).toBe(401);
  });

  describe("the refusals, by code and not by status alone", () => {
    it.each([
      ["?limit=1", 200],
      ["?limit=200", 200],
      ["?limit=0", 400],
      ["?limit=201", 400],
    ])("%s -> %i", async (query, status) => {
      expect((await get(query)).status).toBe(status);
    });

    it("refuses an action outside the vocabulary, naming the field", async () => {
      const res = await get("?action=POST%20%2Fv1%2Fnothing");
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      // `webhooks.itest.ts` asserted status and message text and passed for three
      // chapters while the body said `internal_error`. Only the code could have caught
      // it.
      expect(body["code"]).toBe("invalid_request");
    });

    it("refuses a malformed cursor rather than serving the top of the window", async () => {
      const res = await get("?cursor=not-a-cursor");
      expect(res.status).toBe(400);
      expect((await res.json() as Record<string, unknown>)["code"]).toBe(
        "invalid_request",
      );
    });

    it("refuses an unknown query parameter", async () => {
      // `z.strictObject`, which is the half that is easy to drop: a plain `z.object`
      // accepts `limt=200` and silently serves the default 50, so a caller's typo
      // becomes a wrong answer rather than a 400.
      expect((await get("?limt=5")).status).toBe(400);
    });
  });

  it("builds an actor from the request the way the five module factories do", () => {
    // `actorFrom` IS THE ONE PIECE OF THIS CHAPTER WITH NO ROUTE OF ITS OWN, and the
    // read route does not use it — the write path does. Asserted here because this is
    // the file that holds a real request shape.
    expect(
      actorFrom({
        principal: { kind: "user", environmentId, userExternalId: "log-reader" },
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      kind: "user",
      id: "log-reader",
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    // A REQUEST WITHOUT A PRINCIPAL NEVER REACHES A CONTROLLER, so this is the factory
    // running in a test that built one by hand. `undefined` keeps the entry unwritable
    // rather than writing a wrong one.
    expect(actorFrom({ requestId: "x" })).toBeUndefined();
    expect(
      actorFrom({ principal: { kind: "platform", service: "dispatcher" } }),
    ).toBeUndefined();
  });
});
