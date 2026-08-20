import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AckPolicy, connect, DeliverPolicy, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ALL_ANALYTICS_SUBJECT, ANALYTICS_STREAM } from "@relay/protocol";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { ensureAnalyticsStream } from "../outbox/jetstream.publisher";
import {
  createEnvironment,
  drainDueDeliveries,
  expandEventToDeliveries,
  recordAttemptOutcome,
  Repository,
} from "../db/repository";
import { encryptSecret, mintSigningSecret } from "./secret";
import { MAX_ATTEMPTS } from "./schedule";

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


// The attempt record, against a real broker and a real api (chapter 3.6).
//
// Invariants 1, 2, 3 and 5 of contracts/attempts.md live here. Invariant 4 is the
// swallowed publish failure and is pure, so it lives in analytics.test.ts.
//
// This suite drives the INTERNAL ROUTE over HTTP rather than calling
// `publishAttempt` itself, and that is the whole point of it being an integration
// test. The claim under test is not "the publisher works" — the unit lane holds
// that — it is "recording an outcome puts exactly one event on the stream, and the
// publish happens outside the transaction that recorded it". Neither half is
// visible from inside the publisher.
//
// Every environment is minted here, and every assertion is scoped to a subject
// carrying that environment's id. The stream is global and this lane runs beside
// other suites, so an assertion that counted messages on `analytics.>` would be
// counting somebody else's work (chapter 3.3's finding 4, again).

const CREDENTIAL =
  process.env["RELAY_INTERNAL_CREDENTIAL"] ??
  "rk_svc_attempts_itest_0123456789abcdef0123";

/** A per-run consumer name. A durable IS a position in a shared stream, and
 * chapter 3.6's own baseline is the reason this is a per-SUITE prefix rather than
 * a shared `itest-`: the api's consumer suite once swept every consumer whose name
 * began with that, and deleted a live one belonging to another suite. */
const SUITE = "itest-attempts";

describe("the attempt record", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let nats: NatsConnection;
  let env: { id: string };
  let repo: Repository;
  let durable: string;

  const seedEndpoint = async (
    scope: Repository,
    eventTypes = ["message.created"],
  ) => {
    const secret = mintSigningSecret();
    return scope.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes,
      secretCiphertext: encryptSecret(secret),
    });
  };

  /** The relay's claim, with the publish stubbed out.
   *
   * `drainDueDeliveries` takes the publish as a callback — the seam that makes
   * chapter 3.3's outbox broker-agnostic — so claiming a delivery without putting
   * it on the DELIVERIES stream is a one-line stub rather than a mock. This suite
   * is about the ANALYTICS stream, and a real delivery publish here would hand
   * work to whatever dispatcher happens to be running beside it. */
  const claimOnly = () => drainDueDeliveries(db, 50, async () => {});

  /** Expand one event into deliveries and claim them, which is what leaves a row
   * an outcome can be reported against. The relay's claim is included because an
   * unclaimed delivery is not one the dispatcher would ever have posted. */
  const deliveryFor = async (environmentId: string, scope: Repository) => {
    const eventId = randomUUID();
    await expandEventToDeliveries(db, {
      eventId,
      environmentId,
      type: "message.created",
      payload: { id: eventId, type: "message.created" },
    });
    await claimOnly();
    const [row] = await scope.listDeliveriesForEvent(eventId);
    expect(row).toBeDefined();
    return { eventId, delivery: row! };
  };

  const report = (body: Record<string, unknown>) =>
    fetch(`${url}/internal/dispatch/outcome`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CREDENTIAL}`,
      },
      body: JSON.stringify(body),
    });

  /** Everything this suite has taken off the stream, filed by environment.
   *
   * A BUFFER rather than a filter, and the first version of this file got it
   * wrong in a way worth recording: it acknowledged every message it read and
   * returned only the ones matching the environment asked for. Reading
   * environment A's records therefore consumed and discarded environment B's, and
   * the two-tenant test failed looking for a record that had already been thrown
   * away by the assertion before it. A shared position needs shared bookkeeping. */
  const inbox = new Map<string, Record<string, unknown>[]>();

  /** Take whatever is available right now, file it, acknowledge it. Records from
   * other suites in this lane land here too and are acknowledged so they do not
   * come back; they simply never match an environment any test asks about. */
  const drain = async (): Promise<void> => {
    const consumer = await nats.jetstream().consumers.get(ANALYTICS_STREAM, durable);
    const messages = await consumer.fetch({ max_messages: 100, expires: 1_000 });
    for await (const msg of messages) {
      const payload = msg.json<Record<string, unknown>>();
      msg.ack();
      const key = String(payload["environment_id"]);
      inbox.set(key, [...(inbox.get(key) ?? []), payload]);
    }
  };

  /** Poll until this environment has at least `atLeast`, then answer with all of
   * them.
   *
   * Polls rather than peeks: the publish happens after the outcome commits, so a
   * single fetch races the broker — and a test that fetches once is testing
   * something the platform never does. Chapter 3.5's suite learned this and said
   * so in as many words. */
  const collected = async (
    environmentId: string,
    atLeast = 1,
    budgetMs = 15_000,
  ): Promise<Record<string, unknown>[]> => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      await drain();
      if ((inbox.get(environmentId) ?? []).length >= atLeast) break;
    }
    return inbox.get(environmentId) ?? [];
  };

  /** Every environment this suite mints, so its leftovers can be settled.
   *
   * The relay's drain is GLOBAL and claims 50 due rows at a time, oldest first.
   * Reports of failure reschedule their delivery, so a suite that reports failures
   * and never delivers them leaves rows that are due again a second later and stay
   * that way. Enough of them starve a later suite's own delivery out of the window
   * — which is exactly how four `dispatcher.itest.ts` tests failed under the
   * coverage lane, with nothing delivered and no error anywhere. */
  const minted: string[] = [];
  const mintEnvironment = async (name: string) => {
    const created = await createEnvironment(db, { name });
    minted.push(created.id);
    return created;
  };

  beforeAll(async () => {
    process.env["RELAY_INTERNAL_CREDENTIAL"] = CREDENTIAL;
    db = createDb(createPool());
    env = await createEnvironment(db, { name: "attempts-itest" });
    minted.push(env.id);
    repo = new Repository(db, env.id);

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();

    nats = await connect({
      servers: process.env["RELAY_NATS_URL"] ?? "nats://localhost:4222",
    });

    // The stream is created by the API SERVICE, not here — one definition of a
    // stream, as chapter 3.5 established for DELIVERIES. So the first outcome is
    // reported before any consumer exists, which is also the honest ordering: the
    // platform must not need a reader in order to write.
    await seedEndpoint(repo);
    const { delivery } = await deliveryFor(env.id, repo);
    await report({
      delivery_id: delivery.id,
      attempt: 1,
      status: 200,
      latency_ms: 12,
    });

    const jsm = await nats.jetstreamManager();
    durable = `${SUITE}-${randomUUID().slice(0, 8)}`;
    await jsm.consumers.add(ANALYTICS_STREAM, {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      // ALL, not New. The point of a seven-day retention is that a consumer
      // arriving late still finds what it missed, and this consumer is arriving
      // late on purpose — the record above was published before it existed.
      deliver_policy: DeliverPolicy.All,
      filter_subject: ALL_ANALYTICS_SUBJECT,
    });
  }, 60_000);

  afterAll(async () => {
    if (nats && !nats.isClosed()) {
      const jsm = await nats.jetstreamManager();
      // The durable goes with the run. Chapter 3.5's dispatcher suite leaked two
      // consumers per run onto a shared broker and 3.6's baseline found ninety of
      // them; this file does not add to that count.
      await jsm.consumers.delete(ANALYTICS_STREAM, durable).catch(() => undefined);
      // And the stream comes BACK, because the last test in this file deletes it.
      // Leaving it deleted made every later suite in the lane log a swallowed
      // publish failure — harmless by design, and still a whole lane of api
      // instances quietly recording nothing. The api cannot restore it itself: its
      // publisher ensures the stream when it opens a connection, and that
      // connection is cached for the process's life.
      //
      // Restored by calling THE API'S OWN `ensureAnalyticsStream`, not by declaring
      // the configuration again here. The first version of this teardown wrote its
      // own `streams.add` and left out `max_bytes`, so the stream a reader then
      // inspected with `stream-info.mjs` was the TEST's stream wearing the api's
      // name — unbounded where the api bounds it at a gigabyte. Two definitions of
      // one stream is a drift waiting for the day they disagree, and it took two
      // hours to arrive.
      await ensureAnalyticsStream(nats).catch(() => undefined);
      await nats.drain();
    }
    if (minted.length > 0) {
      const list = minted.map((id) => `'${id}'`).join(",");
      await db.execute(
        `UPDATE webhook_deliveries SET state = 'dead'
          WHERE state = 'pending' AND environment_id IN (${list})`,
      );
    }
    await app?.close();
  }, 60_000);

  it("invariant 1: the stream exists with the configuration the contract states", async () => {
    // Created by the api's own publisher on first use — nothing in this file
    // created it, and a test that created it would be asserting on its own work.
    const info = await (await nats.jetstreamManager()).streams.info(ANALYTICS_STREAM);
    expect(info.config.subjects).toEqual([ALL_ANALYTICS_SUBJECT]);
    expect(info.config.max_age).toBe(7 * 24 * 60 * 60 * 1_000_000_000);
    expect(info.config.discard).toBe("old");
    expect(info.config.retention).toBe("limits");
  });

  it("invariants 1, 2, 3: a recorded outcome publishes one event carrying the four identifiers", async () => {
    const scoped = await mintEnvironment("attempts-itest-one");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);
    const { eventId, delivery } = await deliveryFor(scoped.id, scopedRepo);

    const response = await report({
      delivery_id: delivery.id,
      attempt: 1,
      status: 200,
      latency_ms: 143,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "delivered" });

    const events = await collected(scoped.id);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      delivery_id: delivery.id,
      endpoint_id: endpoint.id,
      environment_id: scoped.id,
      event_id: eventId,
      attempt: 1,
      status: 200,
      latency_ms: 143,
      outcome: "delivered",
    });
    // FR-004: identifiers, statuses and durations. Nothing else, and asserted as
    // an exact key set so an added field fails here rather than shipping.
    expect(Object.keys(event!).sort()).toEqual([
      "attempt",
      "attempted_at",
      "delivery_id",
      "endpoint_id",
      "environment_id",
      "event_id",
      "latency_ms",
      "outcome",
      "status",
    ]);
    expect(typeof event!["attempted_at"]).toBe("string");
  });

  it("records a timeout with NO status rather than omitting the attempt", async () => {
    // FR-001's hardest case. Nothing answered, so there is no status to report —
    // and the attempt still happened, which is exactly what a customer asking
    // "what did you do on my behalf" needs to see.
    const scoped = await mintEnvironment("attempts-itest-timeout");
    const scopedRepo = new Repository(db, scoped.id);
    await seedEndpoint(scopedRepo);
    const { delivery } = await deliveryFor(scoped.id, scopedRepo);

    await report({
      delivery_id: delivery.id,
      attempt: 1,
      error: "timeout after 10000ms",
      latency_ms: 10_000,
    });

    const [event] = await collected(scoped.id);
    expect(event).toBeDefined();
    expect("status" in event!).toBe(false);
    expect(event!["error"]).toBe("timeout after 10000ms");
    expect(event!["latency_ms"]).toBe(10_000);
    expect(event!["outcome"]).toBe("rescheduled");
  });

  it("publishes one event per attempt across a whole exhausted schedule", async () => {
    // US1's third acceptance scenario, and the only place in the chapter that
    // drives a delivery to exhaustion on the stream. Seven attempts, seven
    // events, ascending, with the last one dead-lettered.
    //
    // The tiers are not waited out — `recordAttemptOutcome` is called directly
    // for attempts 2..7 and the schedule's clock is irrelevant to what gets
    // published. Waiting for the real 2h tier would make this test unrunnable,
    // and the thing under test is the record, not the delay.
    const scoped = await mintEnvironment("attempts-itest-full");
    const scopedRepo = new Repository(db, scoped.id);
    await seedEndpoint(scopedRepo);
    const { delivery } = await deliveryFor(scoped.id, scopedRepo);

    await report({
      delivery_id: delivery.id,
      attempt: 1,
      status: 500,
      latency_ms: 20,
    });
    // Attempts 2..7 go through the route too, so every one of them exercises the
    // publish. Each needs the row to be due and claimed again first.
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      await db.execute(
        `UPDATE webhook_deliveries
            SET next_attempt_at = now() - interval '1 second', dispatched_at = NULL
          WHERE id = '${delivery.id}'`,
      );
      await claimOnly();
      const response = await report({
        delivery_id: delivery.id,
        attempt,
        status: 500,
        latency_ms: 20,
      });
      expect(response.status).toBe(200);
    }

    const events = await collected(scoped.id, MAX_ATTEMPTS, 30_000);
    expect(events).toHaveLength(MAX_ATTEMPTS);
    expect(events.map((e) => e["attempt"])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Six reschedules and then the end of the road.
    expect(events.slice(0, MAX_ATTEMPTS - 1).map((e) => e["outcome"])).toEqual(
      Array(MAX_ATTEMPTS - 1).fill("rescheduled"),
    );
    expect(events.at(-1)!["outcome"]).toBe("dead_lettered");
  }, 60_000);

  it("invariant 1: a REPEATED report publishes nothing the second time", async () => {
    // The dispatcher posts, reports, then acknowledges, so a crash in the last
    // gap makes a second report ordinary. It changes no row — and nothing on the
    // analytical path deduplicates, so a second event here would show a customer
    // a retry that never happened.
    const scoped = await mintEnvironment("attempts-itest-repeat");
    const scopedRepo = new Repository(db, scoped.id);
    await seedEndpoint(scopedRepo);
    const { delivery } = await deliveryFor(scoped.id, scopedRepo);

    const body = {
      delivery_id: delivery.id,
      attempt: 1,
      status: 200,
      latency_ms: 30,
    };
    const first = await report(body);
    const second = await report(body);
    // The dispatcher is told the same thing both times — that is what idempotent
    // means here — so the repeat is invisible to it.
    expect(withoutRequestId(await first.json())).toEqual(
      withoutRequestId(await second.json()),
    );

    // Spend a real budget looking for a second event rather than checking once.
    const events = await collected(scoped.id, 2, 5_000);
    expect(events).toHaveLength(1);
  }, 30_000);

  it("FR-018: no attempt event crosses a tenant boundary", async () => {
    // Two environments, one report each, and each one's subject carries only its
    // own. The subject is the filter a future consumer will use, so a mismatch
    // between subject and payload is the shape a cross-tenant leak would take
    // here — nothing would error, and one customer's dashboard would show
    // another's traffic.
    const a = await mintEnvironment("attempts-itest-tenant-a");
    const b = await mintEnvironment("attempts-itest-tenant-b");
    const repoA = new Repository(db, a.id);
    const repoB = new Repository(db, b.id);
    await seedEndpoint(repoA);
    await seedEndpoint(repoB);

    const first = await deliveryFor(a.id, repoA);
    const second = await deliveryFor(b.id, repoB);
    await report({
      delivery_id: first.delivery.id,
      attempt: 1,
      status: 200,
      latency_ms: 10,
    });
    await report({
      delivery_id: second.delivery.id,
      attempt: 1,
      status: 500,
      latency_ms: 11,
    });

    const forA = await collected(a.id);
    const forB = await collected(b.id);
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forA[0]!["delivery_id"]).toBe(first.delivery.id);
    expect(forB[0]!["delivery_id"]).toBe(second.delivery.id);
    // Neither environment's id appears in the other's record, in any field.
    expect(JSON.stringify(forA)).not.toContain(b.id);
    expect(JSON.stringify(forB)).not.toContain(a.id);
  }, 30_000);

  it("carries no payload, secret or signature, whatever the delivery held", async () => {
    // SC-006 end to end. The unit test proves `shape` is an allow-list; this
    // proves the thing actually on the stream contains none of a real delivery's
    // sensitive parts, including the endpoint's url and the event body.
    const scoped = await mintEnvironment("attempts-itest-secrets");
    const scopedRepo = new Repository(db, scoped.id);
    const secret = mintSigningSecret();
    const endpoint = await scopedRepo.createEndpoint({
      url: "https://customer.example/secret-path",
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(secret),
    });
    const eventId = randomUUID();
    await expandEventToDeliveries(db, {
      eventId,
      environmentId: scoped.id,
      type: "message.created",
      payload: {
        id: eventId,
        type: "message.created",
        data: { text: "B2, north ramp" },
      },
    });
    await claimOnly();
    const [row] = await scopedRepo.listDeliveriesForEvent(eventId);

    await report({
      delivery_id: row!.id,
      attempt: 1,
      status: 200,
      latency_ms: 9,
    });

    const serialised = JSON.stringify(await collected(scoped.id));
    expect(serialised).toContain(endpoint.id);
    for (const forbidden of [
      secret,
      "B2, north ramp",
      "customer.example",
      "secret-path",
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  }, 30_000);

  it("FR-009: a customer disabling their own endpoint leaves no platform fingerprint", async () => {
    // The other half of the distinction the disable columns exist to draw, and it
    // is testable before auto-disable exists: `setEndpointEnabled(false)` must
    // leave `disabled_at` null.
    const scoped = await mintEnvironment("attempts-itest-manual");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    await scopedRepo.setEndpointEnabled(endpoint.id, false);

    const [row] = (
      await db.execute(
        `SELECT enabled, disabled_at, disabled_reason,
                failure_run_started_at, failure_run_attempts
           FROM webhook_endpoints WHERE id = '${endpoint.id}'`,
      )
    ).rows as {
      enabled: boolean;
      disabled_at: string | null;
      disabled_reason: string | null;
      failure_run_started_at: string | null;
      failure_run_attempts: number | null;
    }[];

    expect(row!.enabled).toBe(false);
    expect(row!.disabled_at).toBeNull();
    expect(row!.disabled_reason).toBeNull();
    expect(row!.failure_run_started_at).toBeNull();
    expect(row!.failure_run_attempts).toBeNull();
  });

  it("persists what the endpoint answered on the delivery row", async () => {
    // The state the test event and the sweep both read (data-model.md). Chapter
    // 3.5 recorded an attempt by moving the delivery and discarded the answer;
    // this is the column that stops the sweep having to write "cause unknown".
    const scoped = await mintEnvironment("attempts-itest-last");
    const scopedRepo = new Repository(db, scoped.id);
    await seedEndpoint(scopedRepo);
    const { delivery } = await deliveryFor(scoped.id, scopedRepo);

    await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: 1,
      status: 503,
      latencyMs: 214,
    });

    const [row] = (
      await db.execute(
        `SELECT last_status, last_error, last_latency_ms
           FROM webhook_deliveries WHERE id = '${delivery.id}'`,
      )
    ).rows as {
      last_status: number | null;
      last_error: string | null;
      last_latency_ms: number | null;
    }[];
    expect(row!.last_status).toBe(503);
    expect(row!.last_latency_ms).toBe(214);
    expect(row!.last_error).toBeNull();
  });
  it("invariant 5: an outcome is recorded and answered with the ANALYTICS stream deleted", async () => {
    // THE CONSTITUTION III TEST, and the reason this chapter publishes after the
    // commit instead of inside it. Deleting the stream is a sharper instrument
    // than stopping the broker and needs no container restart: the connection is
    // healthy, the publish is refused.
    //
    // If a delivery can fail because analytics is unwell, the design is wrong —
    // not the test.
    //
    // LAST IN THE FILE ON PURPOSE. The api's publisher ensures its stream when it
    // opens a connection, and that connection is cached for the process's life —
    // so a stream deleted underneath it is NOT recreated, and every later publish
    // from this app instance fails. That is a real limitation and it is recorded
    // in the chapter rather than papered over here: an operator who deletes this
    // stream loses attempt records until the api restarts. Nothing after this test
    // may depend on the stream, so nothing is.
    const scoped = await mintEnvironment("attempts-itest-nostream");
    const scopedRepo = new Repository(db, scoped.id);
    await seedEndpoint(scopedRepo);
    const { delivery } = await deliveryFor(scoped.id, scopedRepo);

    const jsm = await nats.jetstreamManager();
    await jsm.streams.delete(ANALYTICS_STREAM);

    const started = Date.now();
    const response = await report({
      delivery_id: delivery.id,
      attempt: 1,
      status: 200,
      latency_ms: 55,
    });
    const elapsed = Date.now() - started;

    // Unchanged answer, unchanged row. The delivery does not care.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "delivered" });
    const [row] = await scopedRepo.listDeliveriesForEvent(delivery.event_id);
    expect(row!.state).toBe("delivered");
    // And it did not sit waiting on a broker that was never going to answer. The
    // bound is generous — this asserts "not stalled", not a latency budget.
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);
});
