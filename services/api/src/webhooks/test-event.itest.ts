import "reflect-metadata";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  recordAttemptOutcome,
  Repository,
} from "../db/repository";
import { encryptSecret, mintSigningSecret } from "./secret";

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


// Proving an endpoint works again (chapter 3.6, FR-WHK-09, research R8).
//
// THIS SUITE PLAYS THE DISPATCHER. `POST /test` creates a real delivery and then
// watches the row, because the attempt happens in another process — so something
// has to make that attempt, and importing the dispatcher's build into the api's
// test lane would make this suite fail whenever the packages happened to build in
// the other order.
//
// Playing it by hand is also the stronger test. The signature is verified with
// `node:crypto` and the documented recipe, nothing from the signing path, which is
// how a customer verifies and the only way to check FR-014's claim that a test
// event is signed exactly as a real one.

const CREDENTIAL =
  process.env["RELAY_INTERNAL_CREDENTIAL"] ??
  "rk_svc_testevent_itest_0123456789abcdef01";

interface Received {
  body: string;
  headers: Record<string, string>;
}

describe("the test event", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let server: Server;
  let endpointUrl: string;
  let received: Received[] = [];
  let answerStatus = 200;
  /** When true the endpoint accepts the request and never answers, so the
   * dispatcher-side attempt below reports a timeout rather than a status. */
  let answerNothing = false;
  const minted: string[] = [];

  const listen = () =>
    new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += String(chunk)));
        req.on("end", () => {
          received.push({
            body,
            headers: Object.fromEntries(
              Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
            ),
          });
          if (answerNothing) return; // accepted and abandoned
          res.writeHead(answerStatus, { "content-type": "text/plain" }).end("ok");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/hook`);
      });
    });

  const mintEnvironment = async (name: string) => {
    const created = await createEnvironment(db, { name });
    minted.push(created.id);
    return created;
  };

  /** An endpoint pointed at this suite's server.
   *
   * Created through the REPOSITORY rather than the public route, because the
   * public route refuses loopback addresses — chapter 3.5's SSRF check, which is
   * correct and which every local walk in this repository has to step around the
   * same way. */
  const seedEndpoint = async (repo: Repository, secret: string) =>
    repo.createEndpoint({
      url: endpointUrl,
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(secret),
    });

  /** Everything a dispatcher does for one delivery: take the material, post it
   * signed, report the outcome. Run concurrently with the request under test,
   * because that request is holding a customer's connection open waiting for
   * exactly this to happen.
   *
   * FINDS ITS OWN ROW rather than calling the relay's drain, and the first version
   * did the opposite. `drainDueDeliveries` is GLOBAL — it claims the fifty oldest
   * due deliveries in the platform regardless of who they belong to — so when
   * another suite in this package drained at the wrong moment it claimed this
   * suite's delivery, discarded it, and stamped `dispatched_at`. Nothing here ever
   * saw it, the route waited out its ten seconds, and the test failed reporting
   * `delivered: false` for an endpoint that had answered 200 the last time it was
   * asked. It passed alone and failed in the lane, which is the shape of every
   * other cross-suite fault this chapter has found.
   *
   * The claim is not what is under test. Selecting the row directly removes the
   * race without weakening anything the assertions rest on. */
  const actAsDispatcher = async (
    environmentId: string,
    budgetMs = 8_000,
  ): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const { rows } = (await db.execute(
        `SELECT id, attempt FROM webhook_deliveries
          WHERE environment_id = '${environmentId}'
            AND state = 'pending'
          ORDER BY created_at DESC
          LIMIT 1`,
      )) as unknown as { rows: { id: string; attempt: number }[] };
      const deliveryId: string | null = rows[0]?.id ?? null;
      if (deliveryId === null) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      const material = await fetch(`${url}/internal/dispatch/material`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${CREDENTIAL}`,
        },
        body: JSON.stringify({ delivery_id: deliveryId }),
      }).then((r) => r.json() as Promise<{
        attempt: number;
        secrets: string[];
        payload: unknown;
      }>);

      // THE RAW BYTES, signed once and sent unchanged. Re-serialising between
      // signing and sending is the single most common way a first integration
      // fails, and it fails looking like the platform's bug.
      const rawBody = JSON.stringify(material.payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", material.secrets[0]!)
        .update(`v1:${timestamp}:${rawBody}`)
        .digest("hex");

      const started = Date.now();
      let status: number | undefined;
      let error: string | undefined;
      try {
        const response = await fetch(endpointUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "relay-webhook-timestamp": timestamp,
            "relay-webhook-signature": `v1=${signature}`,
          },
          body: rawBody,
          signal: AbortSignal.timeout(2_000),
        });
        status = response.status;
      } catch (caught) {
        error = String(caught);
      }

      await recordAttemptOutcome(db, {
        deliveryId,
        attempt: material.attempt,
        ...(status !== undefined ? { status } : {}),
        ...(error !== undefined ? { error } : {}),
        latencyMs: Date.now() - started,
      });
      return;
    }
  };

  const sendTest = (endpointId: string, credential: string) =>
    fetch(`${url}/v1/webhooks/${endpointId}/test`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });

  const endpointRow = async (id: string) => {
    const { rows } = (await db.execute(
      `SELECT enabled, disabled_at, disabled_reason,
              failure_run_started_at, failure_run_attempts
         FROM webhook_endpoints WHERE id = '${id}'`,
    )) as unknown as {
      rows: {
        enabled: boolean;
        disabled_at: Date | null;
        disabled_reason: string | null;
        failure_run_started_at: Date | null;
        failure_run_attempts: number | null;
      }[];
    };
    return rows[0]!;
  };

  beforeAll(async () => {
    process.env["RELAY_INTERNAL_CREDENTIAL"] = CREDENTIAL;
    db = createDb(createPool());
    endpointUrl = await listen();

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    if (minted.length > 0) {
      const list = minted.map((id) => `'${id}'`).join(",");
      await db.execute(
        `UPDATE webhook_deliveries SET state = 'dead'
          WHERE state = 'pending' AND environment_id IN (${list})`,
      );
    }
    server?.close();
    await app?.close();
  }, 60_000);

  it("FR-014, FR-015: delivers a signed synthetic event and reports what it answered", async () => {
    const env = await mintEnvironment("test-event-itest-ok");
    const key = await createApiKey(db, { environmentId: env.id });
    const repo = new Repository(db, env.id);
    const secret = mintSigningSecret();
    const endpoint = await seedEndpoint(repo, secret);

    received = [];
    answerStatus = 200;
    answerNothing = false;

    const [response] = await Promise.all([
      sendTest(endpoint.id, key.credential),
      actAsDispatcher(env.id),
    ]);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["delivered"]).toBe(true);
    expect(body["status"]).toBe(200);
    expect(typeof body["latency_ms"]).toBe("number");
    expect(body["error"]).toBeNull();
    expect(body["event_id"]).toBeTruthy();

    // MARKED TWICE (FR-015). A recipient switching on the type and a recipient
    // reading the body can each tell without knowing about the other.
    expect(received).toHaveLength(1);
    const envelope = JSON.parse(received[0]!.body) as Record<string, unknown>;
    expect(envelope["type"]).toBe("webhook.test");
    expect(envelope["test"]).toBe(true);
    expect(envelope["id"]).toBe(body["event_id"]);
    expect(envelope["environment_id"]).toBe(env.id);

    // THE SIGNATURE, verified the way a customer verifies: `node:crypto`, the
    // documented recipe, and the raw body as it arrived. Nothing from the signing
    // path — a test that verified with our own code would prove only that the code
    // agrees with itself.
    const timestamp = received[0]!.headers["relay-webhook-timestamp"]!;
    const offered = received[0]!.headers["relay-webhook-signature"]!
      .split(",")
      .map((part) => part.trim().replace(/^v1=/, ""));
    const expected = createHmac("sha256", secret)
      .update(`v1:${timestamp}:${received[0]!.body}`)
      .digest("hex");
    const matches = offered.some((candidate) => {
      const a = Buffer.from(candidate, "hex");
      const b = Buffer.from(expected, "hex");
      return a.length === b.length && timingSafeEqual(a, b);
    });
    expect(matches).toBe(true);
  }, 60_000);

  it("FR-013: is delivered even when the endpoint is DISABLED", async () => {
    // The case that makes the loop closable. Refusing here would mean a customer
    // could only find out whether their repair worked by re-enabling and waiting
    // for real traffic — which is how an endpoint gets disabled twice in a day.
    const env = await mintEnvironment("test-event-itest-disabled");
    const key = await createApiKey(db, { environmentId: env.id });
    const repo = new Repository(db, env.id);
    const endpoint = await seedEndpoint(repo, mintSigningSecret());
    await repo.setEndpointEnabled(endpoint.id, false);

    received = [];
    answerStatus = 200;
    answerNothing = false;

    const [response] = await Promise.all([
      sendTest(endpoint.id, key.credential),
      actAsDispatcher(env.id),
    ]);

    expect((await response.json())["delivered"]).toBe(true);
    expect(received).toHaveLength(1);
    // And testing does NOT re-enable it. Only the customer does that.
    expect((await endpointRow(endpoint.id)).enabled).toBe(false);
  }, 60_000);

  it("FR-016: a non-2xx is `delivered: false` with the status, not an HTTP error", async () => {
    const env = await mintEnvironment("test-event-itest-500");
    const key = await createApiKey(db, { environmentId: env.id });
    const repo = new Repository(db, env.id);
    const endpoint = await seedEndpoint(repo, mintSigningSecret());

    received = [];
    answerStatus = 503;
    answerNothing = false;

    const [response] = await Promise.all([
      sendTest(endpoint.id, key.credential),
      actAsDispatcher(env.id),
    ]);

    // The TEST succeeded — it found out. That is why this is a 200.
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["delivered"]).toBe(false);
    expect(body["status"]).toBe(503);
  }, 60_000);

  it("reports an endpoint that never answers as delivered: false with an error", async () => {
    // Spec edge case: "a test event sent to an endpoint whose URL no longer
    // resolves". Modelled as a server that accepts and abandons, which is the
    // harder version — a refused connection fails fast, a hang costs the timeout.
    const env = await mintEnvironment("test-event-itest-hang");
    const key = await createApiKey(db, { environmentId: env.id });
    const repo = new Repository(db, env.id);
    const endpoint = await seedEndpoint(repo, mintSigningSecret());

    received = [];
    answerNothing = true;

    const [response] = await Promise.all([
      sendTest(endpoint.id, key.credential),
      actAsDispatcher(env.id),
    ]);
    answerNothing = false;

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["delivered"]).toBe(false);
    // No status, because nothing answered. Inventing one would make a customer
    // debug a response their server never sent.
    expect(body["status"]).toBeNull();
    expect(String(body["error"])).toBeTruthy();
  }, 60_000);

  it("invariant 13: the outcome leaves the failure run exactly as it was", async () => {
    // Both directions. A failed test must not push an endpoint toward
    // disablement; a successful one must not clear a run and let a customer mask
    // a real outage by testing until it passes.
    const env = await mintEnvironment("test-event-itest-run");
    const key = await createApiKey(db, { environmentId: env.id });
    const repo = new Repository(db, env.id);
    const endpoint = await seedEndpoint(repo, mintSigningSecret());

    // Open a run with a real failure first.
    await db.execute(
      `UPDATE webhook_endpoints
          SET failure_run_started_at = now() - interval '10 minutes',
              failure_run_attempts = 3
        WHERE id = '${endpoint.id}'`,
    );
    const before = await endpointRow(endpoint.id);

    received = [];
    answerStatus = 500;
    answerNothing = false;
    await Promise.all([sendTest(endpoint.id, key.credential), actAsDispatcher(env.id)]);
    expect(await endpointRow(endpoint.id)).toEqual(before);

    answerStatus = 200;
    await Promise.all([sendTest(endpoint.id, key.credential), actAsDispatcher(env.id)]);
    expect(await endpointRow(endpoint.id)).toEqual(before);
  }, 90_000);

  it("FR-017: re-enabling clears all four columns", async () => {
    const env = await mintEnvironment("test-event-itest-reenable");
    const key = await createApiKey(db, { environmentId: env.id });
    const repo = new Repository(db, env.id);
    const endpoint = await seedEndpoint(repo, mintSigningSecret());

    // Disabled by the platform, with a run behind it.
    await db.execute(
      `UPDATE webhook_endpoints
          SET enabled = false,
              disabled_at = now(),
              disabled_reason = '5 consecutive failures over 1h02m; last status 503',
              failure_run_started_at = now() - interval '62 minutes',
              failure_run_attempts = 5
        WHERE id = '${endpoint.id}'`,
    );

    const response = await fetch(`${url}/v1/webhooks/${endpoint.id}/enable`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.credential}` },
    });
    expect(response.status).toBe(200);

    const after = await endpointRow(endpoint.id);
    expect(after.enabled).toBe(true);
    expect(after.disabled_at).toBeNull();
    expect(after.disabled_reason).toBeNull();
    expect(after.failure_run_started_at).toBeNull();
    expect(after.failure_run_attempts).toBeNull();

    // And the representation says so, which is what a customer actually reads.
    const shown = (await response.json()) as Record<string, unknown>;
    expect(shown["disabled_at"]).toBeNull();
    expect(shown["failure_run_attempts"]).toBeNull();
  }, 60_000);

  it("FR-017: the hour is measured from the NEXT failure, not resumed", async () => {
    // Without this, a customer who repaired their server and switched it back on
    // would be disabled again by the first failure afterwards — on the strength of
    // an outage they had already fixed.
    const env = await mintEnvironment("test-event-itest-fresh");
    const repo = new Repository(db, env.id);
    const endpoint = await seedEndpoint(repo, mintSigningSecret());

    await db.execute(
      `UPDATE webhook_endpoints
          SET enabled = false, disabled_at = now(),
              disabled_reason = 'x',
              failure_run_started_at = now() - interval '90 minutes',
              failure_run_attempts = 9
        WHERE id = '${endpoint.id}'`,
    );
    await repo.setEndpointEnabled(endpoint.id, true);

    // One fresh failure, reported directly.
    const eventId = randomUUID();
    const { rows } = (await db.execute(
      `INSERT INTO webhook_deliveries (id, environment_id, endpoint_id, event_id, payload)
       VALUES ('${randomUUID()}', '${env.id}', '${endpoint.id}', '${eventId}', '{}')
       RETURNING id`,
    )) as unknown as { rows: { id: string }[] };
    await recordAttemptOutcome(db, {
      deliveryId: rows[0]!.id,
      attempt: 1,
      status: 500,
      latencyMs: 3,
    });

    const after = await endpointRow(endpoint.id);
    // A NEW run of one, not a resumed run of ten.
    expect(after.failure_run_attempts).toBe(1);
    expect(after.enabled).toBe(true);
    // And its start is recent, not ninety minutes ago.
    expect(Date.now() - new Date(after.failure_run_started_at!).getTime()).toBeLessThan(
      60_000,
    );
  }, 60_000);

  it("FR-TEN-05: a test against another environment's endpoint answers 404", async () => {
    const mine = await mintEnvironment("test-event-itest-mine");
    const theirs = await mintEnvironment("test-event-itest-theirs");
    const myKey = await createApiKey(db, { environmentId: mine.id });
    const theirEndpoint = await seedEndpoint(
      new Repository(db, theirs.id),
      mintSigningSecret(),
    );

    received = [];
    const response = await sendTest(theirEndpoint.id, myKey.credential);

    expect(response.status).toBe(404);
    // The same answer a missing endpoint gets, so a probe cannot tell one from the
    // other — and nothing was delivered.
    const missing = await sendTest(randomUUID(), myKey.credential);
    expect(missing.status).toBe(404);
    expect(withoutRequestId(await response.json())).toEqual(
      withoutRequestId(await missing.json()),
    );
    expect(received).toHaveLength(0);
  }, 60_000);

  it("answers honestly when nothing is there to make the attempt", async () => {
    // No dispatcher, nobody playing one. The route must not hang for ever and must
    // not claim the endpoint is unhealthy — it does not know that. This is the one
    // case where `error` describes the PLATFORM rather than the customer.
    const env = await mintEnvironment("test-event-itest-nodispatcher");
    const key = await createApiKey(db, { environmentId: env.id });
    const repo = new Repository(db, env.id);
    const endpoint = await seedEndpoint(repo, mintSigningSecret());

    received = [];
    const response = await sendTest(endpoint.id, key.credential);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["delivered"]).toBe(false);
    expect(body["status"]).toBeNull();
    expect(String(body["error"])).toContain("dispatcher");
    expect(received).toHaveLength(0);
  }, 60_000);
});
