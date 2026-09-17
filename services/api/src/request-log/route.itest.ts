import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { mintUserToken } from "../auth/user-token";
import { createDb, createPool, type Db } from "../db/client";
import { createAnalyticalStore } from "../metering/clickhouse";
import { migrate } from "../db/migrate";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { createRequestLogReader } from "./reader";
import { buildRequestLogQuerySchema } from "./request-log.schema";

// FR-ANL-07's route over real HTTP (chapter 4.8).
//
// SEPARATE FROM `query.itest.ts`, WHICH OWNS THE READER. What only a route can show is
// here: the guard's decision, the validation pipe's refusals, what the request costs the
// tenant's budget, and what the surface does when the store does not answer. Everything
// about WHAT COMES BACK is next door, against the store directly, where a failure names
// the statement instead of the stack.

const RATELIMIT_REMAINING = "x-ratelimit-remaining";

describe("GET /v1/request-log", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let environmentId: string;
  let credential: string;
  /** A token for a person signed into the tenant's product. The route must refuse it. */
  let userToken: string;

  const ch = async (sql: string): Promise<string> => {
    const res = await fetch(
      `http://${process.env["RELAY_CLICKHOUSE_HOST"] ?? "localhost"}:${process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123"}/`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from("relay:relay").toString("base64"),
        },
        body: sql,
      },
    );
    const text = await res.text();
    if (!res.ok) throw new Error(text.trim().split("\n")[0] ?? "clickhouse refused");
    return text.trim();
  };

  const get = (query: string, token = credential): Promise<Response> =>
    fetch(`${url}/v1/request-log${query}`, {
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

    const env = await createEnvironment(db, { name: "request-log-route" });
    environmentId = env.id;
    ({ credential } = await createApiKey(db, { environmentId }));
    const repo = new Repository(db, environmentId);
    await repo.createUser("log-reader", "Log Reader");
    const secret = (await environmentSigningSecret(db, environmentId))!.signingSecret;
    userToken = (
      await mintUserToken(secret, {
        user: "log-reader",
        environmentId,
        ttlSeconds: 3600,
      })
    ).token;

    // One row, so a 200 has something in it. The route is the subject here, not the
    // paging — but a 200 over an empty table would pass every assertion below for the
    // wrong reason, and the lane ships no ingester to fill it.
    await ch(
      `INSERT INTO relay_analytics.api_requests
         (environment_id, ts, request_id, endpoint, method, status, latency_ms, principal_kind, refused_at)
       VALUES (toUUID('${environmentId}'), now64(3), toUUID('${randomUUID()}'), '/v1/request-log', 'GET', 200, 1.5, 'application', 'handler')`,
    );
  });

  afterAll(async () => {
    await ch(
      `ALTER TABLE relay_analytics.api_requests DELETE WHERE environment_id = toUUID('${environmentId}')`,
    );
    await app.close();
  });

  it("answers a tenant's own application credential", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: unknown[]; has_more: boolean };
    expect(Array.isArray(body.requests)).toBe(true);
    expect(body.requests.length).toBeGreaterThan(0);
  });

  /** T013's decision, asserted rather than described. `CredentialGuard` defaults to
   * `EITHER` when no `@Accepts` is present, so the absence of this test is the absence of
   * any evidence the decorator is there at all — and the decorator is the whole of the
   * decision. */
  it("refuses an end-user token: a person in the product is not the product", async () => {
    const res = await get("", userToken);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("wrong_credential_type");
  });

  it("refuses no credential at all", async () => {
    const res = await fetch(`${url}/v1/request-log`);
    expect(res.status).toBe(401);
  });

  /** FR-005, against the real route rather than against the schema. */
  describe("the limit bound", () => {
    it.each([
      ["1", 200],
      ["200", 200],
      ["201", 400],
      ["0", 400],
    ])("limit=%s -> %i", async (limit, status) => {
      expect((await get(`?limit=${limit}`)).status).toBe(status);
    });

    it("refuses a typo rather than serving the default", async () => {
      // `z.strictObject`. A plain `z.object` answers 200 with fifty rows here, and the
      // caller never learns their filter was ignored.
      expect((await get("?limt=200")).status).toBe(400);
    });
  });

  it("refuses an endpoint the router does not serve, and names the field", async () => {
    const res = await get("?endpoint=%2Fv1%2Fnope");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["field"]).toBe("endpoint");
  });

  it("accepts an endpoint the router does serve", async () => {
    expect((await get("?endpoint=%2Fv1%2Frequest-log")).status).toBe(200);
  });

  /** FR-027 AND SC-016, AND THE DECISION IS TO LEAVE IT COUNTED.
   *
   * `operationsFor` returns `["rest"]` for every path under `/v1` — there is no route
   * list and no exemption — so this route was counted from the moment it existed and
   * nobody chose that. It stays counted: an exemption list is a hand-maintained table,
   * and feature 045 deleted one of those rather than correct it after two hand-allocated
   * port bands turned out to contain services the lane itself runs.
   *
   * The consequence is the chapter's rather than a defect to route around: **a customer
   * investigating 429s reads their request log, the reads spend the budget they are
   * investigating, and the log then shows the 429s the reading caused.** */
  it("spends the tenant's REST budget, which is a decision and not an oversight", async () => {
    const first = await get("");
    const second = await get("");
    const before = Number(first.headers.get(RATELIMIT_REMAINING));
    const after = Number(second.headers.get(RATELIMIT_REMAINING));
    expect(Number.isNaN(before)).toBe(false);
    expect(after).toBe(before - 1);
  });

  /** FR-025, FR-032, SC-014, AND EIR-API-04's FIVE FIELDS.
   *
   * AN EMPTY PAGE IS THE DANGEROUS WRONG ANSWER, which is why this asserts the body and
   * not the status alone: an empty page says the tenant made no requests, a claim about
   * them, where the platform is what failed. Constitution III's second clause is a MUST
   * about exactly this shape — the API is up and this one surface is not.
   *
   * The store is pointed at a closed port, so the fetch is refused rather than timing
   * out: `AnalyticalStoreError` carries status 0 for "no answer at all", which is the
   * same arm a timeout's 408 lands in. Driving a real timeout would take two seconds of
   * lane time to measure the same branch. */
  it("refuses with 503 analytics_unavailable when the store does not answer", async () => {
    const dead = createRequestLogReader(
      createAnalyticalStore({ port: "1", timeoutMs: 500 }),
    );
    const schema = buildRequestLogQuerySchema(new Set(["/v1/request-log"]));
    const refusal = await dead
      .page(environmentId, schema.parse({}))
      .then(() => null)
      .catch((e: unknown) => e as { getStatus?: () => number; getResponse?: () => unknown });
    expect(refusal).not.toBeNull();
    expect(refusal?.getStatus?.()).toBe(503);
    const body = refusal?.getResponse?.() as Record<string, unknown>;
    expect(body["code"]).toBe("analytics_unavailable");
    // NEVER THE STORE'S OWN ANSWER. `Code: 159. DB::Exception: … elapsed 1000.34 ms` in a
    // customer's support ticket is infrastructure detail (NFR-SEC-06).
    expect(String(body["message"])).not.toMatch(/DB::Exception|Code: \d+|ECONNREFUSED/);
  });

  /** THE FIVE FIELDS, THROUGH THE FILTER, WHICH IS THE ONLY PLACE THEY EXIST.
   * `ProtocolErrorFilter` assembles `docs_url` and `request_id`; the thrower names `code`
   * and `field`. A test on the thrown exception alone would assert three of five. */
  it("sends EIR-API-04's five fields, top-level and not nested", async () => {
    const res = await get("?limit=201");
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(typeof body["code"]).toBe("string");
    expect(typeof body["message"]).toBe("string");
    expect(typeof body["docs_url"]).toBe("string");
    expect(typeof body["request_id"]).toBe("string");
    expect(body["field"]).toBe("limit");
    expect(body["error"]).toBeUndefined();
  });

  /** T039c: READING THE LOG WRITES TO THE LOG, AND THE MEASUREMENT NEEDS A CONTROL FIRST.
   *
   * `RequestLogMiddleware` records on `res.on("finish")` for every request including
   * GETs, so each page this suite reads publishes a record of itself. **With no ingester
   * draining, the difference between two consecutive pages is zero** — and zero reads as
   * *"the surface excludes its own reads"* when it means *"nothing filled the table"*.
   * That is the instrument defect this project has published a wrong conclusion from more
   * than once, so the control comes first: the row this suite planted by hand is the
   * proof the read path works at all, and the absence below is then attributable.
   *
   * THE DECISION: the surface does NOT exclude its own route. Excluding it would make the
   * log incomplete against FR-ANL-01's *"every request"*, and the caller can already
   * filter `endpoint=/v1/request-log` out — the same argument, one route over, as the
   * `/internal/*` decision. */
  it("does not exclude its own route, and nothing arrives to prove it here", async () => {
    const before = (await (await get("")).json()) as { requests: { endpoint: string }[] };
    // THE CONTROL. Without this line the assertion below is about an empty table.
    expect(before.requests.length).toBeGreaterThan(0);
    await get("");
    const after = (await (await get("")).json()) as { requests: { endpoint: string }[] };
    // The planted row names this route, so `/v1/request-log` IS returned when a row for
    // it exists — which is the decision. What does not happen is new rows arriving, and
    // the reason is the ingester `compose.yaml` does not run (050-8).
    expect(after.requests.some((r) => r.endpoint === "/v1/request-log")).toBe(true);
    expect(after.requests.length).toBe(before.requests.length);
  });
});
