import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { mintUserToken } from "../auth/user-token";
import { COUNTER_STORE } from "./limits.module";
import { createCounterStore, type CounterStore } from "./store";
import { environments } from "../db/schema";
import { eq } from "drizzle-orm";

// The limiter over real HTTP against the compose Postgres and Redis
// (chapter 3.8). Each `it` mints what it needs; the suite's own environments
// keep it out of every other suite's way — 2.1's isolation property paying for
// itself again.

const HEADERS = {
  limit: "x-ratelimit-limit",
  remaining: "x-ratelimit-remaining",
  reset: "x-ratelimit-reset",
} as const;

describe("the limiter", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;

  /** An environment with a channel and a key, at whatever limits the caller
   * asks for. `undefined` leaves the column null, which means "use the
   * documented default" — and null is not zero. */
  const seed = async (name: string, limits?: { rest?: number; send?: number }) => {
    const env = await createEnvironment(db, { name });
    if (limits) {
      await db
        .update(environments)
        .set({
          restLimitPerMinute: limits.rest ?? null,
          sendLimitPerMinute: limits.send ?? null,
        })
        .where(eq(environments.id, env.id));
    }
    const channel = await new Repository(db, env.id).createChannel("c", "public");
    const { credential } = await createApiKey(db, { environmentId: env.id });
    return { env, channelId: channel.id, credential };
  };

  const send = (
    channelId: string,
    credential: string,
    text = "one",
  ): Promise<Response> =>
    fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ text }),
    });

  beforeAll(async () => {
    const pool = createPool();
    // Migrations here, like every other suite that needs a schema newer than
    // whatever the database happens to be at. Chapter 3.8's `0008` adds the
    // policy columns, and a suite that assumed they existed would pass on a
    // developer's machine and fail on a fresh one.
    await migrate(pool);
    db = createDb(pool);
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it("carries all three headers on a SUCCESSFUL response", async () => {
    // FR-RTL-02, and the requirement an afterthought passes: a limiter that only
    // speaks when it refuses satisfies every test written from the 429.
    const { channelId, credential } = await seed("limits-headers");

    const res = await send(channelId, credential);

    expect(res.status).toBe(201);
    expect(res.headers.get(HEADERS.limit)).toBe("600");
    expect(res.headers.get(HEADERS.remaining)).toBe("599");
    expect(Number(res.headers.get(HEADERS.reset))).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
  });

  it("counts down across successive responses", async () => {
    const { channelId, credential } = await seed("limits-countdown");

    const first = await send(channelId, credential);
    const second = await send(channelId, credential);

    expect(Number(first.headers.get(HEADERS.remaining))).toBe(599);
    expect(Number(second.headers.get(HEADERS.remaining))).toBe(598);
  });

  it("refuses with 429, Retry-After, and a four-field body", async () => {
    // Two requests allowed, the third refused. Testing a threshold means
    // lowering it — driving 600 requests would measure the test runner.
    const { channelId, credential } = await seed("limits-refusal", { rest: 2 });

    await send(channelId, credential);
    await send(channelId, credential);
    const refused = await send(channelId, credential);

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get(HEADERS.remaining)).toBe("0");

    const body = (await refused.json()) as Record<string, unknown>;
    // TOP-LEVEL, not nested under an `error` key. EIR-API-04's example showed it
    // nested until this chapter checked what the platform actually sends; the SRS
    // is amended to 1.3 and the flat shape is the documented one. This assertion
    // is what stops the next reader of that requirement from "fixing" the code.
    expect(body["code"]).toBe("rate_limited");
    expect(typeof body["message"]).toBe("string");
    expect(typeof body["docs_url"]).toBe("string");
    expect(typeof body["request_id"]).toBe("string");
  });

  it("counts a REST send against BOTH budgets, and reports the nearer", async () => {
    // FR-036. The send limit counts messages wherever they enter, so a REST send
    // spends one of each. With `send` set lower than `rest`, the headers must
    // follow `send` — the one that will refuse first is the only value a client
    // can schedule against (research R11).
    const { channelId, credential } = await seed("limits-both", {
      rest: 100,
      send: 3,
    });

    const first = await send(channelId, credential);

    expect(first.headers.get(HEADERS.limit)).toBe("3");
    expect(first.headers.get(HEADERS.remaining)).toBe("2");
  });

  it("names WHICH limit was reached, because they are different problems", async () => {
    // "too many requests" says batch; "too many messages" says slow down. The
    // code stays `rate_limited` — it is the protocol constant — and the message
    // carries the distinction. Neither names a credential (NFR-SEC-06).
    const { channelId, credential } = await seed("limits-which", {
      rest: 100,
      send: 1,
    });

    await send(channelId, credential);
    const refused = await send(channelId, credential);
    const body = (await refused.json()) as { message: string };

    expect(refused.status).toBe(429);
    expect(body.message).toContain("messages");
    expect(body.message).not.toContain(credential);
  });

  it("never limits /healthz, whatever the environment has spent", async () => {
    // Docker polls it every five seconds and `up -d --wait` depends on the
    // answer. A limiter that can refuse a health check can stop a deployment.
    const { channelId, credential } = await seed("limits-health", { rest: 1 });
    await send(channelId, credential);
    expect((await send(channelId, credential)).status).toBe(429);

    const health = await fetch(`${url}/healthz`);

    expect(health.status).toBe(200);
    expect(health.headers.get(HEADERS.limit)).toBeNull();
  });

  it("does not count the gateway's internal routes as requests", async () => {
    // THE CASE A PRINCIPAL-BASED EXEMPTION MISSES. The gateway forwards the END
    // USER's token on `/internal/session`, `/internal/backfill` and
    // `/internal/messages`, all `@Accepts("user")` — so its calls resolve exactly
    // like customer traffic and only the route can tell them apart.
    //
    // Counting them again would charge a socket send twice and let a reconnect
    // storm eat a customer's request budget (research R17).
    const env = await createEnvironment(db, { name: "limits-internal" });
    await db
      .update(environments)
      .set({ restLimitPerMinute: 1 })
      .where(eq(environments.id, env.id));
    const repo = new Repository(db, env.id);
    const user = await repo.createUser("tuan", "Tuan");
    const channel = await repo.createChannel("fleet", "public");
    await repo.addMember(channel.id, user.id);
    const secret = (await environmentSigningSecret(db, env.id))!.signingSecret;
    const { token } = await mintUserToken(secret, {
      user: "tuan",
      environmentId: env.id,
      ttlSeconds: 3600,
    });

    // Spend the environment's single request slot on the public path.
    const { credential } = await createApiKey(db, { environmentId: env.id });
    await send(channel.id, credential);
    expect((await send(channel.id, credential)).status).toBe(429);

    // The gateway's door is a different door, and it is still open.
    const session = await fetch(`${url}/internal/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
    });

    expect(session.status).toBe(200);
    expect(session.headers.get(HEADERS.limit)).toBeNull();
  });

  it("does not count the dispatcher, which reaches every environment", async () => {
    // A limiter that throttles the dispatcher turns one busy customer's webhook
    // backlog into a stall for every customer — the failure FR-WHK-05 forbids and
    // chapter 3.5's retry schedule was built to avoid.
    //
    // Unlike the gateway, this one IS recognisable by principal: the platform
    // credential belongs to a deployment rather than a tenant, so it carries no
    // environment to key on. Both are exempt; only one of them could have been
    // exempted by looking at who was asking.
    const credentialEnv = process.env["RELAY_INTERNAL_CREDENTIAL"];
    expect(credentialEnv, "the lane must configure a platform credential").toBeTruthy();

    const res = await fetch(`${url}/internal/dispatch/material`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentialEnv ?? ""}`,
      },
      body: JSON.stringify({ delivery_id: "00000000-0000-0000-0000-000000000000" }),
    });

    // Whatever it answers about a delivery that does not exist, it is not a 429
    // and it carries no allowance headers — the route was never counted.
    expect(res.status).not.toBe(429);
    expect(res.headers.get(HEADERS.limit)).toBeNull();
  });

  it("an override applies to ONE environment, not to every environment", async () => {
    // FR-007's configurability, and the half SC-003 needed: the journey map asks
    // for "separate keys and separate quotas", so Mai can hammer her dev
    // environment without moving production's ceiling. Independent counters
    // would pass a weaker version of this test.
    const tight = await seed("limits-tight", { rest: 2 });
    const loose = await seed("limits-loose");

    await send(tight.channelId, tight.credential);
    await send(tight.channelId, tight.credential);
    const refused = await send(tight.channelId, tight.credential);
    const other = await send(loose.channelId, loose.credential);

    expect(refused.status).toBe(429);
    expect(other.status).toBe(201);
    expect(other.headers.get(HEADERS.limit)).toBe("600");
  });

  it("carries the fourth field on EVERY error, not only the 429", async () => {
    // Constitution V has asked for `code`, `message`, `docs_url` and
    // `request_id` since chapter 1.3. The platform sent three for twenty-two
    // chapters, above a comment promising the fourth would "join in Part 2, when
    // a gateway exists to mint one".
    //
    // Four fields on one status and three on the others would be worse than
    // either consistent answer, so this checks the statuses nobody was thinking
    // about when the rate limiter was specified.
    const notFound = await fetch(`${url}/v1/nope`);
    const unauthorized = await fetch(`${url}/v1/channels/x/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    for (const res of [notFound, unauthorized]) {
      const body = (await res.json()) as Record<string, unknown>;
      // TOP-LEVEL, not nested under an `error` key — EIR-API-04's example showed
      // it nested until this chapter checked, and the SRS is amended to 1.3.
      expect(body["error"]).toBeUndefined();
      expect(typeof body["code"]).toBe("string");
      expect(typeof body["message"]).toBe("string");
      expect(typeof body["docs_url"]).toBe("string");
      expect(body["request_id"]).toBe(res.headers.get("x-request-id"));
    }
  });

  it("refuses an address past the failed-auth threshold, and says nothing extra", async () => {
    // FR-AUT-12 and FR-028. Past the threshold the refusal must be
    // INDISTINGUISHABLE from a wrong-credential refusal — a limiter that answers
    // differently for a credential it would have accepted is an oracle.
    //
    // Its own key prefix, because the lane runs files in parallel and every
    // suite asserting a 401 from loopback lands in one bucket. A suite that
    // needs a LOW threshold needs a private key, not a private number
    // (research R21).
    const previousPrefix = process.env["RELAY_AUTH_KEY_PREFIX"];
    const previousThreshold = process.env["RELAY_AUTH_FAILURES_PER_MINUTE"];
    process.env["RELAY_AUTH_KEY_PREFIX"] = `rlauth-itest-${Date.now()}`;
    process.env["RELAY_AUTH_FAILURES_PER_MINUTE"] = "3";
    try {
      const bad = () =>
        fetch(`${url}/v1/channels/x/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer rk_live_not_a_real_key_at_all_000000",
          },
          body: JSON.stringify({ text: "hi" }),
        });

      const first = await bad();
      expect(first.status).toBe(401);

      await bad();
      await bad();
      const refused = await bad();

      expect(refused.status).toBe(429);
      const body = (await refused.json()) as { code: string; message: string };
      expect(body.code).toBe("rate_limited");
      // Never the credential (NFR-SEC-06), and no hint about whether it was
      // valid.
      expect(body.message).not.toContain("rk_live");
      expect(body.message).not.toContain("valid");
    } finally {
      if (previousPrefix === undefined) delete process.env["RELAY_AUTH_KEY_PREFIX"];
      else process.env["RELAY_AUTH_KEY_PREFIX"] = previousPrefix;
      if (previousThreshold === undefined)
        delete process.env["RELAY_AUTH_FAILURES_PER_MINUTE"];
      else process.env["RELAY_AUTH_FAILURES_PER_MINUTE"] = previousThreshold;
    }
  });

  it("counts ten client addresses as ten, not as one gateway", async () => {
    // FR-039. A handshake authenticated through the gateway reaches the api FROM
    // the gateway, so counting the TCP peer would put every customer's failures
    // in one bucket and let one attacker exhaust a threshold that then refused
    // everybody.
    //
    // The address rides the internal contract as a field rather than a header,
    // because a header the caller asserts is a header the caller can forge —
    // chapter 3.2 removed exactly that pattern.
    const previousPrefix = process.env["RELAY_AUTH_KEY_PREFIX"];
    const previousThreshold = process.env["RELAY_AUTH_FAILURES_PER_MINUTE"];
    process.env["RELAY_AUTH_KEY_PREFIX"] = `rlauth-fleet-${Date.now()}`;
    process.env["RELAY_AUTH_FAILURES_PER_MINUTE"] = "3";
    try {
      // Ten distinct clients, one bad handshake each, all arriving from this
      // process — which is what the gateway looks like to the api.
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${url}/internal/session`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer not.a.real.token",
          },
          body: JSON.stringify({ client_address: `198.51.100.${i}` }),
        });
        // Every one is a 401: ten addresses, one failure each, none over three.
        expect(res.status, `client ${i} should be refused for its credential`).toBe(
          401,
        );
      }
    } finally {
      if (previousPrefix === undefined) delete process.env["RELAY_AUTH_KEY_PREFIX"];
      else process.env["RELAY_AUTH_KEY_PREFIX"] = previousPrefix;
      if (previousThreshold === undefined)
        delete process.env["RELAY_AUTH_FAILURES_PER_MINUTE"];
      else process.env["RELAY_AUTH_FAILURES_PER_MINUTE"] = previousThreshold;
    }
  });

  it("two environments carry DIFFERENT configured limits, each at its own number", async () => {
    // Independent counters are half of what the journey map asks for. The other
    // half is "separate keys and separate quotas": a developer raises her dev
    // environment's ceiling and hammers it without moving production's.
    //
    // The previous test proves an override applies. This one proves it applies to
    // ONE environment — a shared policy would pass the first and fail here.
    const dev = await seed("limits-dev", { rest: 5 });
    const prod = await seed("limits-prod", { rest: 2 });

    const devFirst = await send(dev.channelId, dev.credential);
    const prodFirst = await send(prod.channelId, prod.credential);

    expect(devFirst.headers.get(HEADERS.limit)).toBe("5");
    expect(prodFirst.headers.get(HEADERS.limit)).toBe("2");

    // Production runs out at two; development still has room at three.
    await send(prod.channelId, prod.credential);
    expect((await send(prod.channelId, prod.credential)).status).toBe(429);
    expect((await send(dev.channelId, dev.credential)).status).toBe(201);
  });
});

// The failure direction, which is what this chapter is actually about
// (FR-010, FR-011, FR-014, research R3, R6).
//
// A REAL ioredis client against a dead port, not a mock that throws. The
// question is what the platform does when a store it depends on is gone, and a
// stub that rejects on command would answer a different question — it would skip
// connection handling, which is where the first draft of `store.ts` got it wrong.
//
// A dead port rather than stopping the container, because the lane runs files in
// PARALLEL and stopping Redis would break every other suite mid-run.
describe("when the counter store is gone", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let channelId: string;
  let credential: string;
  let deadStore: CounterStore;

  beforeAll(async () => {
    const pool = createPool();
    await migrate(pool);
    db = createDb(pool);
    const env = await createEnvironment(db, { name: "limits-degraded" });
    channelId = (await new Repository(db, env.id).createChannel("c", "public")).id;
    credential = (await createApiKey(db, { environmentId: env.id })).credential;

    // Port 1 is reserved and nothing listens on it.
    deadStore = createCounterStore("redis://127.0.0.1:1");
    app = (
      await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(COUNTER_STORE)
        .useValue(deadStore)
        .compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await deadStore.close();
  });

  it("SERVES the request rather than refusing it", async () => {
    // Redis is not a source of truth (SAD §6.3), and a cache outage is not a
    // reason to refuse a paying customer's traffic. This is the direction the
    // tenant limiter fails in, and it is a decision rather than an accident.
    const res = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ text: "served anyway" }),
    });

    expect(res.status).toBe(201);
  });

  it("keeps Limit and DROPS Remaining and Reset, rather than inventing them", async () => {
    // FR-014. `Limit` is policy read from Postgres and is not degraded. The other
    // two exist only because something was counting, and a client must be able to
    // tell "you have N left" from "we are not counting".
    //
    // NOT a sentinel: a client that does not know `-1` would parse it as a number
    // and conclude it was over its limit (research R6).
    const res = await fetch(`${url}/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({ text: "no counts" }),
    });

    expect(res.headers.get(HEADERS.limit)).toBe("600");
    expect(res.headers.get(HEADERS.remaining)).toBeNull();
    expect(res.headers.get(HEADERS.reset)).toBeNull();
  });

  it("does NOT let an address spend an unlimited number of failed logins", async () => {
    // The other direction, in the same outage, and the reason the chapter exists.
    // Failing open here is not a degradation — it is a brute-force window. The
    // in-process fallback holds the same threshold per instance, so the guarantee
    // weakens from N per window per fleet to N per window per instance rather
    // than disappearing.
    const previous = process.env["RELAY_AUTH_FAILURES_PER_MINUTE"];
    process.env["RELAY_AUTH_FAILURES_PER_MINUTE"] = "3";
    try {
      const bad = () =>
        fetch(`${url}/v1/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer rk_live_still_not_a_real_key_0000000",
          },
          body: JSON.stringify({ text: "hi" }),
        });

      expect((await bad()).status).toBe(401);
      await bad();
      await bad();

      expect((await bad()).status).toBe(429);
    } finally {
      if (previous === undefined)
        delete process.env["RELAY_AUTH_FAILURES_PER_MINUTE"];
      else process.env["RELAY_AUTH_FAILURES_PER_MINUTE"] = previous;
    }
  });
});
