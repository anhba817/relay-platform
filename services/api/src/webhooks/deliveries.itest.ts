import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import {
  createEnvironment,
  deliveryMaterial,
  DeliveryNotFoundError,
  drainDueDeliveries,
  expandEventToDeliveries,
  pendingDeliveryDepth,
  recordAttemptOutcome,
  replayDeadLetter,
  Repository,
  sweepDisabledEndpoints,
  timesHandled,
} from "../db/repository";
import { createLogger } from "@relay/service-kit";

import { createDeliveryRelay } from "./delivery-relay";
import { MAX_ATTEMPTS, RETRY_TIERS_MS } from "./schedule";
import { encryptSecret, mintSigningSecret } from "./secret";

// The delivery schedule (chapter 3.5). Invariant 8 lives here; 9, 10 and 12
// join it as the tiers and the dead-letter path arrive.
//
// Every environment is minted in this file — the drain is global, so a
// per-environment assertion is the only kind that survives another suite
// running beside it. Chapter 3.3's finding 4 is the reason that sentence exists.

const DISPATCHER = "dispatcher";

describe("expansion", () => {
  let db: Db;
  let env: { id: string };
  let repo: Repository;

  const seedEndpoint = async (eventTypes: string[]) => {
    const secret = mintSigningSecret();
    return repo.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes,
      secretCiphertext: encryptSecret(secret),
    });
  };

  const event = (environmentId: string) => ({
    eventId: randomUUID(),
    environmentId,
    type: "message.created",
    payload: { id: randomUUID(), type: "message.created" },
  });

  beforeAll(async () => {
    db = createDb(createPool());
    env = await createEnvironment(db, { name: "deliveries-itest" });
    repo = new Repository(db, env.id);
  });

  afterAll(async () => {
    // nothing to close: the pool is process-lived, as in every other suite
  });

  it("invariant 8: one event matching N endpoints produces N delivery rows", async () => {
    await seedEndpoint(["message.created"]);
    await seedEndpoint(["message.created"]);
    // Subscribed to something else — must not receive this event (invariant 7's
    // half that is decided at expansion rather than at delivery).
    await seedEndpoint(["channel.created"]);

    const e = event(env.id);
    const result = await expandEventToDeliveries(db, e);

    expect(result.duplicate).toBe(false);
    expect(result.created).toBe(2);

    const rows = await repo.listDeliveriesForEvent(e.eventId);
    expect(rows).toHaveLength(2);
    // Every row starts due immediately, on tier 1, pending.
    for (const row of rows) {
      expect(row.attempt).toBe(1);
      expect(row.state).toBe("pending");
    }
  });

  it("invariant 8: expansion runs once however often the event is redelivered", async () => {
    await seedEndpoint(["message.created"]);
    const e = event(env.id);

    const first = await expandEventToDeliveries(db, e);
    const second = await expandEventToDeliveries(db, e);
    const third = await expandEventToDeliveries(db, e);

    expect(first.duplicate).toBe(false);
    // The broker will redeliver — that is what at-least-once means. Doubling
    // every webhook on a redelivery is the failure this prevents, and it is
    // prevented by the database rather than by care.
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);
    expect(second.created).toBe(0);
    expect(third.created).toBe(0);

    expect(await repo.listDeliveriesForEvent(e.eventId)).toHaveLength(
      first.created,
    );
    // And the claim is chapter 3.4's ledger, unchanged.
    expect(await timesHandled(db, DISPATCHER, e.eventId)).toBe(1);
  });

  it("invariant 8: an event no endpoint subscribes to expands to nothing, and that is not an error", async () => {
    const quiet = await createEnvironment(db, { name: "deliveries-itest-quiet" });
    const e = { ...event(quiet.id), type: "message.created" };

    const result = await expandEventToDeliveries(db, e);

    expect(result.duplicate).toBe(false);
    expect(result.created).toBe(0);
    // Still claimed. An event with no subscribers is handled, not pending — or
    // every redelivery would re-ask the same question forever.
    expect(await timesHandled(db, DISPATCHER, e.eventId)).toBe(1);
  });

  it("invariant 8: a disabled or deleted endpoint receives nothing", async () => {
    const scratch = await createEnvironment(db, { name: "deliveries-itest-off" });
    const scratchRepo = new Repository(db, scratch.id);
    const secret = encryptSecret(mintSigningSecret());

    const live = await scratchRepo.createEndpoint({
      url: "https://example.test/live",
      eventTypes: ["message.created"],
      secretCiphertext: secret,
    });
    const paused = await scratchRepo.createEndpoint({
      url: "https://example.test/paused",
      eventTypes: ["message.created"],
      secretCiphertext: secret,
    });
    const removed = await scratchRepo.createEndpoint({
      url: "https://example.test/removed",
      eventTypes: ["message.created"],
      secretCiphertext: secret,
    });
    await scratchRepo.setEndpointEnabled(paused.id, false);
    await scratchRepo.deleteEndpoint(removed.id);

    const e = event(scratch.id);
    const result = await expandEventToDeliveries(db, e);

    expect(result.created).toBe(1);
    const rows = await scratchRepo.listDeliveriesForEvent(e.eventId);
    expect(rows.map((r) => r.endpoint_id)).toEqual([live.id]);
  });
});

describe("the outcome of an attempt", () => {
  let db: Db;
  let env: { id: string };
  let repo: Repository;

  const seed = async () => {
    await repo.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(mintSigningSecret()),
    });
    const e = {
      eventId: randomUUID(),
      environmentId: env.id,
      type: "message.created",
      payload: { id: randomUUID() },
    };
    await expandEventToDeliveries(db, e);
    const [delivery] = await repo.listDeliveriesForEvent(e.eventId);
    return delivery!;
  };

  beforeAll(async () => {
    db = createDb(createPool());
    env = await createEnvironment(db, { name: "outcome-itest" });
    repo = new Repository(db, env.id);
  });

  it("marks a 2xx delivered and schedules nothing further", async () => {
    const delivery = await seed();

    const result = await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: 1,
      status: 200,
    });

    expect(result.outcome).toBe("delivered");
    expect(result.nextAttemptAt).toBeNull();
  });

  it("reschedules a failure onto the next tier", async () => {
    const delivery = await seed();
    const before = Date.now();

    const result = await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: 1,
      status: 500,
    });

    expect(result.outcome).toBe("rescheduled");
    // Tier 2 is one second out. Asserted as a bound rather than an equality:
    // the row's clock is the database's, not this process's.
    const due = result.nextAttemptAt!.getTime();
    expect(due).toBeGreaterThanOrEqual(before);
    expect(due).toBeLessThanOrEqual(before + RETRY_TIERS_MS[1]! + 2_000);
  });

  it("treats a timeout — no status at all — as a failure", async () => {
    const delivery = await seed();

    // The platform can only believe a status code it received. Nothing received
    // is not success, however the request may have ended on the customer's side.
    const result = await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: 1,
      error: "connect ETIMEDOUT",
    });

    expect(result.outcome).toBe("rescheduled");
  });

  it("is idempotent on (delivery, attempt) — a repeat does not advance the schedule", async () => {
    const delivery = await seed();

    const first = await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: 1,
      status: 500,
    });
    const repeat = await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: 1,
      status: 500,
    });

    // The dispatcher posts, reports, then acknowledges. A crash between the
    // report and the acknowledgement means this report arrives twice. The POST
    // may duplicate and the customer absorbs it on the event id — but the
    // SCHEDULE must not advance twice for one attempt, or the tiers collapse.
    expect(repeat.outcome).toBe(first.outcome);
    const rows = await repo.listDeliveriesForEvent(delivery.event_id);
    expect(rows[0]!.attempt).toBe(2);
  });

  it("dead-letters once the attempts are exhausted, with the record behind it", async () => {
    const delivery = await seed();

    let outcome = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await recordAttemptOutcome(db, {
        deliveryId: delivery.id,
        attempt,
        status: 503,
        error: "customer endpoint is down",
      });
      outcome = result.outcome;
    }

    expect(outcome).toBe("dead_lettered");
    const dead = await repo.listDeadLetters();
    const mine = dead.filter((d) => d.event_id === delivery.event_id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.attempts).toBe(MAX_ATTEMPTS);
    expect(mine[0]!.last_status).toBe(503);
  });
});

describe("the relay drains only what is due", () => {
  let db: Db;
  let env: { id: string };
  let repo: Repository;

  /** Run the drain, then ask the ROW what happened.
   *
   * The drain is GLOBAL — one dispatcher serves every environment — so a test
   * that asserts on what its own call returned is really asserting that no other
   * suite got there first. Chapter 3.3's finding 3 met this twice; this is the
   * third time, and the fix is the same one: assert the property, not the
   * observer. Whoever claims the row, a due delivery ends up dispatched and a
   * not-yet-due one does not. */
  const drainEverythingDue = async (): Promise<void> => {
    await drainDueDeliveries(db, 500, async () => {});
  };

  const stateOf = async (delivery: { id: string; event_id: string }) => {
    const rows = await repo.listDeliveriesForEvent(delivery.event_id);
    return rows.find((r) => r.id === delivery.id)!;
  };

  const seed = async () => {
    await repo.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(mintSigningSecret()),
    });
    const e = {
      eventId: randomUUID(),
      environmentId: env.id,
      type: "message.created",
      payload: { id: randomUUID() },
    };
    await expandEventToDeliveries(db, e);
    const [delivery] = await repo.listDeliveriesForEvent(e.eventId);
    return delivery!;
  };

  beforeAll(async () => {
    db = createDb(createPool());
    env = await createEnvironment(db, { name: "due-itest" });
    repo = new Repository(db, env.id);
  });

  it("invariant 10: publishes a delivery that is due", async () => {
    const delivery = await seed();

    await drainEverythingDue();

    expect((await stateOf(delivery)).dispatched_at).not.toBeNull();
  });

  it("invariant 10: does NOT publish one that is not yet due", async () => {
    const delivery = await seed();
    // Fail it once: attempt 2 falls due a second from now, so it is pending but
    // not due — and the outcome clears `dispatched_at`.
    await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: 1,
      status: 500,
    });

    await drainEverythingDue();

    expect((await stateOf(delivery)).dispatched_at).toBeNull();
  });

  it("invariant 10: a not-yet-due delivery holds no acknowledgement slot", async () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL DESIGN.
    //
    // Research R1 measured the alternative: a broker-held delay survives a
    // restart to within 3 ms, and holds an acknowledgement slot the whole time
    // it waits. Three messages nak'd for five minutes made two available ones
    // unfetchable — so a handful of dead customer endpoints would starve
    // deliveries to healthy ones, which is what FR-WHK-05 forbids.
    //
    // Here the waiting happens in a row, so the test is not a timing
    // measurement: a healthy endpoint's delivery is published while several
    // others sit on the two-hour tier. Nothing is holding anything.
    const sleeping = [];
    for (let i = 0; i < 3; i++) {
      const d = await seed();
      for (let attempt = 1; attempt <= 6; attempt++) {
        await recordAttemptOutcome(db, { deliveryId: d.id, attempt, status: 503 });
      }
      sleeping.push(d);
    }

    const healthy = await seed();
    await drainEverythingDue();

    expect((await stateOf(healthy)).dispatched_at).not.toBeNull();
    for (const s of sleeping) {
      expect((await stateOf(s)).dispatched_at).toBeNull();
    }
  });

  it("invariant 9: a claimed delivery is not claimed twice", async () => {
    const delivery = await seed();

    await drainEverythingDue();
    const first = await stateOf(delivery);
    await drainEverythingDue();
    const second = await stateOf(delivery);

    // `dispatched_at` is the relay's mark, in the shape `outbox.published_at`
    // has. Without it the same delivery would be republished on every pass until
    // the dispatcher happened to report an outcome — so the mark must not move.
    expect(first.dispatched_at).not.toBeNull();
    expect(second.dispatched_at).toBe(first.dispatched_at);
  });

  it("invariant 9: a rescheduled delivery becomes claimable again when it falls due", async () => {
    const delivery = await seed();
    await drainEverythingDue();

    await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: 1,
      status: 500,
    });
    // The outcome clears the mark, so the next tier is genuinely deliverable
    // rather than stuck behind a flag nobody resets.
    expect((await stateOf(delivery)).dispatched_at).toBeNull();
    expect((await stateOf(delivery)).attempt).toBe(2);

    // Tier 2 is one second out.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await drainEverythingDue();

    expect((await stateOf(delivery)).dispatched_at).not.toBeNull();
  });
});

describe("dead letters", () => {
  let db: Db;
  let env: { id: string };
  let repo: Repository;

  const exhaust = async () => {
    const endpoint = await repo.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(mintSigningSecret()),
    });
    const eventId = randomUUID();
    await expandEventToDeliveries(db, {
      eventId,
      environmentId: env.id,
      type: "message.created",
      payload: { id: eventId, type: "message.created" },
    });
    const [delivery] = await repo.listDeliveriesForEvent(eventId);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await recordAttemptOutcome(db, {
        deliveryId: delivery!.id,
        attempt,
        status: 503,
        error: "customer endpoint is down",
      });
    }
    return { endpointId: endpoint.id, eventId, deliveryId: delivery!.id };
  };

  beforeAll(async () => {
    db = createDb(createPool());
    env = await createEnvironment(db, { name: "deadletter-itest" });
    repo = new Repository(db, env.id);
  });

  it("invariant 12: an exhausted delivery is retained and retrievable", async () => {
    const { eventId, deliveryId } = await exhaust();

    const [dead] = (await repo.listDeadLetters()).filter(
      (d) => d.event_id === eventId,
    );

    expect(dead).toBeDefined();
    expect(dead!.attempts).toBe(MAX_ATTEMPTS);
    expect(dead!.last_status).toBe(503);
    // The failure a human can act on. "It stopped" is not a record; a status and
    // an error are.
    expect(dead!.last_error).toContain("down");

    const [delivery] = await repo.listDeliveriesForEvent(eventId);
    expect(delivery!.id).toBe(deliveryId);
    expect(delivery!.state).toBe("dead");
  });

  it("invariant 12: a replay reuses the ORIGINAL event id", async () => {
    const { eventId } = await exhaust();
    const [dead] = (await repo.listDeadLetters()).filter(
      (d) => d.event_id === eventId,
    );

    const replayed = await replayDeadLetter(db, dead!.id);

    expect(replayed).toBe(true);
    const [delivery] = await repo.listDeliveriesForEvent(eventId);
    // THE POINT. An operator replaying something a customer already received
    // must not harm a customer who deduplicates correctly — so the replay
    // carries the identifier they deduplicate ON, rather than a fresh one that
    // would look like a new event.
    expect(delivery!.event_id).toBe(eventId);
    // Live again, from the first tier: a replay is a fresh chance, not a
    // continuation of an exhausted schedule.
    expect(delivery!.state).toBe("pending");
    expect(delivery!.attempt).toBe(1);
    expect(delivery!.dispatched_at).toBeNull();
  });

  it("invariant 12: a replayed delivery is claimable by the relay", async () => {
    const { eventId } = await exhaust();
    const [dead] = (await repo.listDeadLetters()).filter(
      (d) => d.event_id === eventId,
    );
    await replayDeadLetter(db, dead!.id);

    await drainDueDeliveries(db, 500, async () => {});

    const [delivery] = await repo.listDeliveriesForEvent(eventId);
    // Not merely marked pending — actually picked up. A replay that reappears in
    // the table and never leaves it is a button that does nothing.
    expect(delivery!.dispatched_at).not.toBeNull();
  });

  it("invariant 12: the dead-letter record survives the replay", async () => {
    const { eventId } = await exhaust();
    const [dead] = (await repo.listDeadLetters()).filter(
      (d) => d.event_id === eventId,
    );

    await replayDeadLetter(db, dead!.id);

    // FR-WHK-04 retains dead letters for seven days. A replay is a new attempt,
    // not an erasure of the record that the attempts once ran out — otherwise
    // the only evidence a customer's endpoint was broken disappears the moment
    // somebody retries it.
    const still = (await repo.listDeadLetters()).filter(
      (d) => d.event_id === eventId,
    );
    expect(still).toHaveLength(1);
  });
});

// The material for one attempt.
//
// This block exists because coverage said the two functions below were never
// executed by any test in the instrument. They ARE exercised constantly — the
// dispatcher calls both over HTTP on every pass — but the dispatcher's suite
// runs the api as a CHILD PROCESS, and a child's coverage is not attributable.
// So the one function in the platform that hands a customer's signing secret
// back in plaintext was, by the only measure the constitution names, untested.
describe("the material for one attempt", () => {
  let db: Db;

  /** A FRESH ENVIRONMENT per delivery, and the reason is a bug this suite had
   * for exactly one run: expansion matches every subscribed endpoint in the
   * environment, so a second test seeding a second endpoint made
   * `listDeliveriesForEvent[0]` the FIRST test's delivery. The assertions then
   * rotated one endpoint's secret and read another one's material. One
   * environment per case is the same isolation the top of this file describes,
   * applied one level down. */
  const seedDelivery = async (): Promise<{
    deliveryId: string;
    endpointId: string;
    secret: string;
    eventId: string;
    envId: string;
    repo: Repository;
  }> => {
    const env = await createEnvironment(db, {
      name: `material-itest-${randomUUID().slice(0, 8)}`,
    });
    const repo = new Repository(db, env.id);
    const secret = mintSigningSecret();
    const endpoint = await repo.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(secret),
    });
    const eventId = randomUUID();
    await expandEventToDeliveries(db, {
      eventId,
      environmentId: env.id,
      type: "message.created",
      payload: { id: eventId, type: "message.created" },
    });
    const deliveries = await repo.listDeliveriesForEvent(eventId);
    expect(deliveries).toHaveLength(1);
    return {
      deliveryId: deliveries[0]!.id,
      endpointId: endpoint.id,
      secret,
      eventId,
      envId: env.id,
      repo,
    };
  };

  beforeAll(() => {
    db = createDb(createPool());
  });

  it("hands back the url, the payload and the DECRYPTED secret", async () => {
    const { deliveryId, endpointId, secret, eventId, envId } = await seedDelivery();

    const material = await deliveryMaterial(db, deliveryId);

    expect(material).not.toBeNull();
    expect(material!.endpoint_id).toBe(endpointId);
    expect(material!.event_id).toBe(eventId);
    expect(material!.environment_id).toBe(envId);
    expect(material!.attempt).toBe(1);
    // Plaintext, on purpose and exactly once in the platform. The dispatcher
    // cannot sign with a ciphertext, and it holds no key.
    expect(material!.secrets).toEqual([secret]);
  });

  it("hands back BOTH secrets inside the rotation window", async () => {
    const { deliveryId, endpointId, secret: original, repo } = await seedDelivery();
    const replacement = mintSigningSecret();
    await repo.rotateEndpointSecret(endpointId, encryptSecret(replacement));

    const material = await deliveryMaterial(db, deliveryId);

    // The new one FIRST — a customer verifying against the current secret
    // succeeds on the first comparison, and the old one is only there so a
    // deployment still running yesterday's configuration is not cut off
    // mid-rotation.
    expect(material!.secrets).toEqual([replacement, original]);
  });

  it("hands back nothing for a disabled endpoint", async () => {
    const { deliveryId, endpointId, repo } = await seedDelivery();
    await repo.setEndpointEnabled(endpointId, false);

    // The spec's edge case: deliveries already in the schedule for an endpoint
    // the customer paused must not be delivered. `null` is what the dispatcher
    // turns into `skipped`, which acknowledges the message rather than retrying
    // a delivery that can never succeed.
    expect(await deliveryMaterial(db, deliveryId)).toBeNull();
  });

  it("hands back nothing for a deleted endpoint", async () => {
    const { deliveryId, endpointId, repo } = await seedDelivery();
    await repo.deleteEndpoint(endpointId);

    // Soft-deleted, so the row is still joinable — which is exactly why this
    // check has to be explicit. A hard delete would have made the join fail and
    // hidden the requirement behind a foreign key.
    expect(await deliveryMaterial(db, deliveryId)).toBeNull();
  });

  it("hands back nothing for a delivery id that does not exist", async () => {
    expect(await deliveryMaterial(db, randomUUID())).toBeNull();
  });

  it("counts what is pending and stops counting it once it is delivered", async () => {
    const { deliveryId } = await seedDelivery();

    // GLOBAL, and asserted as a delta for that reason — this is the number an
    // operator watches, so it counts every tenant's backlog, and another suite
    // seeding rows beside this one must not be able to break it.
    const before = await pendingDeliveryDepth(db);
    expect(before).toBeGreaterThan(0);

    await recordAttemptOutcome(db, { deliveryId, attempt: 1, status: 200 });

    expect(await pendingDeliveryDepth(db)).toBe(before - 1);
  });
});

// The answers nobody asks for on a good day.
//
// Every case here is a branch the happy path never reaches: a delivery id that
// is not there, a report that arrives after the schedule has already finished
// with it, a dead-letter with no status because there was never a response. They
// are cheap to write and they are exactly what an on-call engineer meets first,
// because the ordinary paths are the ones that do not page anyone.
describe("the outcome of an attempt, off the happy path", () => {
  let db: Db;

  /** Fresh environment per delivery — one endpoint, one delivery row, no
   * borrowing another case's rows. */
  const seedOne = async () => {
    const env = await createEnvironment(db, {
      name: `outcome-edge-${randomUUID().slice(0, 8)}`,
    });
    const repo = new Repository(db, env.id);
    await repo.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(mintSigningSecret()),
    });
    const eventId = randomUUID();
    await expandEventToDeliveries(db, {
      eventId,
      environmentId: env.id,
      type: "message.created",
      payload: { id: eventId },
    });
    const rows = await repo.listDeliveriesForEvent(eventId);
    expect(rows).toHaveLength(1);
    return { delivery: rows[0]!, repo };
  };

  beforeAll(() => {
    db = createDb(createPool());
  });

  it("refuses an outcome for a delivery that does not exist", async () => {
    // A CALLER error, not a platform one. The dispatcher can only produce this
    // by reporting against an id it invented, so it becomes a 404 rather than a
    // 500 — and the distinction matters, because a 500 would tell the dispatcher
    // to leave the message unacknowledged and try the same impossible report
    // until the broker gave up.
    await expect(
      recordAttemptOutcome(db, { deliveryId: randomUUID(), attempt: 1, status: 200 }),
    ).rejects.toBeInstanceOf(DeliveryNotFoundError);
  });

  it("answers a late report about a DELIVERED delivery with what was decided", async () => {
    const { delivery } = await seedOne();
    await recordAttemptOutcome(db, { deliveryId: delivery.id, attempt: 1, status: 200 });

    // The dispatcher crashed after reporting and before acknowledging, so the
    // broker handed the job back and it reported again. The answer must be the
    // ORIGINAL decision — anything else would have it retry a delivery the
    // customer already received.
    const late = await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: 1,
      status: 200,
    });

    expect(late.outcome).toBe("delivered");
    expect(late.nextAttemptAt).toBeNull();
  });

  it("answers a late report about a DEAD delivery with what was decided", async () => {
    const { delivery } = await seedOne();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await recordAttemptOutcome(db, { deliveryId: delivery.id, attempt, status: 503 });
    }

    const late = await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: MAX_ATTEMPTS,
      status: 503,
    });

    expect(late.outcome).toBe("dead_lettered");
    expect(late.nextAttemptAt).toBeNull();
  });

  it("dead-letters a delivery that never produced a status at all", async () => {
    const { delivery, repo } = await seedOne();
    // Every attempt a timeout: no response, so no status and no body. The
    // dead-letter record has to be writable from nothing but the fact that
    // nothing came back, or the endpoints that fail most completely are the ones
    // that leave the least evidence.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await recordAttemptOutcome(db, { deliveryId: delivery.id, attempt });
    }

    const mine = (await repo.listDeadLetters()).filter(
      (d) => d.event_id === delivery.event_id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.last_status).toBeNull();
    expect(mine[0]!.attempts).toBe(MAX_ATTEMPTS);
  });

  it("refuses to replay a dead letter that does not exist", async () => {
    // `false`, not a throw: the controller turns it into the same 404 a foreign
    // tenant gets, so a probe cannot tell "no such record" from "not yours".
    expect(await replayDeadLetter(db, randomUUID())).toBe(false);
  });
});

// The failure run and automatic disablement (chapter 3.6, FR-006…FR-012).
//
// Invariants 6, 7, 8, 9, 10, 11 and 12 of contracts/webhooks.md live here. The
// policy's arithmetic is pure and lives in `disable.test.ts`; what these need a
// database for is the locking, the at-most-once rule and the sweep.
//
// THE HOUR IS MOVED, NOT WAITED OUT. `failure_run_started_at` is pushed into the
// past with one statement, which is the same thing the walk script's
// `--fast-forward` does for the retry schedule. Waiting sixty-one real minutes
// would make these tests unrunnable, and the thing under test is the decision, not
// the clock.
describe("the failure run", () => {
  let db: Db;
  let env: { id: string };
  let repo: Repository;

  /** Every environment these tests mint, so their leftovers can be settled.
   *
   * THE RELAY'S DRAIN IS GLOBAL and takes 50 due rows at a time, oldest first.
   * These tests report failures, so their deliveries are RESCHEDULED — they fall
   * due again a second later and stay due for ever, because nothing here delivers
   * them. Left behind, a few hundred of them sit at the front of that 50-row
   * window and starve a later suite's own delivery out of it entirely.
   *
   * That is not hypothetical: it failed four tests in `dispatcher.itest.ts` under
   * the coverage lane, which runs every suite in one process, and it failed them
   * with `expected 0 to be greater than 0` — nothing delivered, no error anywhere.
   * The suite that caused it passed.
   *
   * Chapter 3.6's baseline drew the rule twice already: clean up what you created,
   * and only what you created. */
  const minted: string[] = [];
  const mintEnvironment = async (name: string) => {
    const created = await createEnvironment(db, { name });
    minted.push(created.id);
    return created;
  };

  const seedEndpoint = async (scope = repo) => {
    const secret = mintSigningSecret();
    return scope.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(secret),
    });
  };

  /** One claimed delivery for this endpoint, ready to have an outcome reported. */
  const deliveryFor = async (environmentId: string, scope: Repository) => {
    const eventId = randomUUID();
    await expandEventToDeliveries(db, {
      eventId,
      environmentId,
      type: "message.created",
      payload: { id: eventId, type: "message.created" },
    });
    await drainDueDeliveries(db, 50, async () => {});
    const rows = await scope.listDeliveriesForEvent(eventId);
    return rows;
  };

  /** The endpoint's run and disable columns, read with plain SQL — the query
   * engine lives in the repository layer and nowhere else (constitution I,
   * ADR-16), and the lint rule that says so makes no exception for tests. */
  const runOf = async (endpointId: string) => {
    const { rows } = (await db.execute(
      `SELECT enabled, disabled_at, disabled_reason,
              failure_run_started_at, failure_run_attempts
         FROM webhook_endpoints WHERE id = '${endpointId}'`,
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

  const notificationsFor = async (endpointId: string) => {
    const { rows } = (await db.execute(
      `SELECT environment_id, organisation_id, endpoint_id, run_attempts,
              last_status, last_error, delivered_at
         FROM webhook_disable_notifications WHERE endpoint_id = '${endpointId}'`,
    )) as unknown as {
      rows: {
        environment_id: string;
        organisation_id: string;
        endpoint_id: string;
        run_attempts: number;
        last_status: number | null;
        last_error: string | null;
        delivered_at: Date | null;
      }[];
    };
    return rows;
  };

  /** Move this endpoint's run start into the past. The equivalent of waiting. */
  const ageRun = (endpointId: string, minutes: number) =>
    db.execute(
      `UPDATE webhook_endpoints
          SET failure_run_started_at = now() - interval '${minutes} minutes'
        WHERE id = '${endpointId}'`,
    );

  /** Report `count` failures against fresh deliveries to one endpoint. Fresh
   * deliveries rather than one row retried, because the run counts FAILURES
   * against an endpoint and must not care which delivery produced them. */
  const failTimes = async (
    environmentId: string,
    scope: Repository,
    endpointId: string,
    count: number,
    status: number | undefined = 500,
  ) => {
    for (let i = 0; i < count; i++) {
      const rows = await deliveryFor(environmentId, scope);
      const mine = rows.find((r) => r.endpoint_id === endpointId);
      if (!mine) continue;
      await recordAttemptOutcome(db, {
        deliveryId: mine.id,
        attempt: mine.attempt,
        ...(status !== undefined ? { status } : { error: "connection refused" }),
        latencyMs: 12,
      });
    }
  };

  beforeAll(async () => {
    db = createDb(createPool());
    env = await createEnvironment(db, { name: "disable-itest" });
    minted.push(env.id);
    repo = new Repository(db, env.id);
  });

  afterAll(async () => {
    // Settle every delivery these environments left pending. `dead` rather than
    // deleted: the rows are evidence a later reader of this database may want, and
    // a state the relay does not look at costs nothing to keep.
    if (minted.length === 0) return;
    const list = minted.map((id) => `'${id}'`).join(",");
    await db.execute(
      `UPDATE webhook_deliveries SET state = 'dead'
        WHERE state = 'pending' AND environment_id IN (${list})`,
    );
  }, 60_000);

  it("invariant 6: a failure opens the run, and further failures extend it", async () => {
    const scoped = await mintEnvironment("disable-itest-open");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    expect((await runOf(endpoint.id)).failure_run_started_at).toBeNull();

    await failTimes(scoped.id, scopedRepo, endpoint.id, 1);
    const opened = await runOf(endpoint.id);
    expect(opened.failure_run_started_at).not.toBeNull();
    expect(opened.failure_run_attempts).toBe(1);
    // One failure is not a disablement, however long ago it was.
    expect(opened.enabled).toBe(true);

    await failTimes(scoped.id, scopedRepo, endpoint.id, 2);
    const grown = await runOf(endpoint.id);
    expect(grown.failure_run_attempts).toBe(3);
    // The START does not move as the run grows — the window is measured from the
    // first failure, and a start that crept forward would mean an endpoint failing
    // steadily was never an hour old.
    expect(grown.failure_run_started_at).toEqual(opened.failure_run_started_at);
  }, 60_000);

  it("invariant 7: any success clears the run", async () => {
    const scoped = await mintEnvironment("disable-itest-clear");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    await failTimes(scoped.id, scopedRepo, endpoint.id, 3);
    expect((await runOf(endpoint.id)).failure_run_attempts).toBe(3);

    await failTimes(scoped.id, scopedRepo, endpoint.id, 1, 200);

    const cleared = await runOf(endpoint.id);
    expect(cleared.failure_run_started_at).toBeNull();
    expect(cleared.failure_run_attempts).toBeNull();
  }, 60_000);

  it("SC-003: an endpoint that succeeds once an hour is never disabled", async () => {
    // The generous case, and it is generous on purpose: a platform that switches
    // off endpoints which sometimes work is a worse failure than one that keeps
    // trying. Four failures over an aged window, then one success, repeated — the
    // run never reaches both conditions at once because the success resets it.
    const scoped = await mintEnvironment("disable-itest-flaky");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    for (let cycle = 0; cycle < 3; cycle++) {
      await failTimes(scoped.id, scopedRepo, endpoint.id, 4);
      // Age it well past the threshold: even so, four failures are below the floor.
      await ageRun(endpoint.id, 120);
      await failTimes(scoped.id, scopedRepo, endpoint.id, 1, 200);
      expect((await runOf(endpoint.id)).failure_run_started_at).toBeNull();
    }

    const final = await runOf(endpoint.id);
    expect(final.enabled).toBe(true);
    expect(final.disabled_at).toBeNull();
  }, 120_000);

  it("invariants 6 and 11: an hour of failures past the floor disables it, once, with one notification", async () => {
    const scoped = await mintEnvironment("disable-itest-disable");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    // Four failures, then age the run past the hour: still below the floor.
    await failTimes(scoped.id, scopedRepo, endpoint.id, 4);
    await ageRun(endpoint.id, 64);
    expect((await runOf(endpoint.id)).enabled).toBe(true);

    // The fifth crosses both conditions at once.
    await failTimes(scoped.id, scopedRepo, endpoint.id, 1, 503);

    const disabled = await runOf(endpoint.id);
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabled_at).not.toBeNull();
    // FR-009: the reason names the count, the window and what the endpoint said.
    expect(disabled.disabled_reason).toMatch(
      /^5 consecutive failures over 1h0\dm; last status 503$/,
    );

    const notifications = await notificationsFor(endpoint.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.environment_id).toBe(scoped.id);
    expect(notifications[0]!.run_attempts).toBe(5);
    expect(notifications[0]!.last_status).toBe(503);
    // THE HONEST COLUMN. FR-WHK-07 asks for the organisation to be notified by
    // email; this platform has no email, and the null says so.
    expect(notifications[0]!.delivered_at).toBeNull();
    // The organisation was resolved at write time rather than left to a join.
    expect(notifications[0]!.organisation_id).toBeTruthy();
  }, 120_000);

  it("invariant 8: further failures do not disable it again or notify again", async () => {
    const scoped = await mintEnvironment("disable-itest-once");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    await failTimes(scoped.id, scopedRepo, endpoint.id, 4);
    await ageRun(endpoint.id, 64);
    await failTimes(scoped.id, scopedRepo, endpoint.id, 1, 503);
    const first = await runOf(endpoint.id);
    expect(first.enabled).toBe(false);

    // More failures arrive — deliveries already on the schedule from before the
    // disablement, which is exactly the edge case the spec names.
    await failTimes(scoped.id, scopedRepo, endpoint.id, 3, 500);

    expect(await notificationsFor(endpoint.id)).toHaveLength(1);
    // And the disable timestamp is the FIRST one: a second disable would move it,
    // which would quietly rewrite when the customer's outage began.
    expect((await runOf(endpoint.id)).disabled_at).toEqual(first.disabled_at);
  }, 120_000);

  it("invariant 8 under concurrency: two overlapping reports disable once", async () => {
    // THE REASON THE ENDPOINT ROW IS LOCKED. Two dispatcher instances can report
    // outcomes for two deliveries to the same endpoint in the same moment. Without
    // `FOR UPDATE` both read four, both write five, and both decide to disable —
    // two disablements and two notifications for one outage.
    const scoped = await mintEnvironment("disable-itest-race");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    await failTimes(scoped.id, scopedRepo, endpoint.id, 4);
    await ageRun(endpoint.id, 64);

    // Two deliveries, both due, both reported at once.
    const first = (await deliveryFor(scoped.id, scopedRepo)).find(
      (r) => r.endpoint_id === endpoint.id,
    )!;
    const second = (await deliveryFor(scoped.id, scopedRepo)).find(
      (r) => r.endpoint_id === endpoint.id,
    )!;

    await Promise.all([
      recordAttemptOutcome(db, {
        deliveryId: first.id,
        attempt: first.attempt,
        status: 500,
        latencyMs: 5,
      }),
      recordAttemptOutcome(db, {
        deliveryId: second.id,
        attempt: second.attempt,
        status: 500,
        latencyMs: 5,
      }),
    ]);

    expect((await runOf(endpoint.id)).enabled).toBe(false);
    // ONE. This is the assertion the lock exists for.
    expect(await notificationsFor(endpoint.id)).toHaveLength(1);
  }, 120_000);

  it("invariant 9: a disabled endpoint receives no new deliveries", async () => {
    const scoped = await mintEnvironment("disable-itest-nonew");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);
    const healthy = await seedEndpoint(scopedRepo);

    await failTimes(scoped.id, scopedRepo, endpoint.id, 4);
    await ageRun(endpoint.id, 64);
    await failTimes(scoped.id, scopedRepo, endpoint.id, 1, 503);
    expect((await runOf(endpoint.id)).enabled).toBe(false);

    // A new event arrives for the environment. Expansion is where `enabled` is
    // read, so the disabled endpoint simply is not among the rows produced.
    const eventId = randomUUID();
    await expandEventToDeliveries(db, {
      eventId,
      environmentId: scoped.id,
      type: "message.created",
      payload: { id: eventId, type: "message.created" },
    });
    const rows = await scopedRepo.listDeliveriesForEvent(eventId);

    expect(rows.map((r) => r.endpoint_id)).toEqual([healthy.id]);
  }, 120_000);

  it("invariant 10: disabling one endpoint changes nothing for any other", async () => {
    // FR-012 and SC-004. One endpoint in the same environment, one in another —
    // neither loses its run state, its `enabled`, or its deliveries.
    const scoped = await mintEnvironment("disable-itest-iso-a");
    const other = await mintEnvironment("disable-itest-iso-b");
    const scopedRepo = new Repository(db, scoped.id);
    const otherRepo = new Repository(db, other.id);

    const doomed = await seedEndpoint(scopedRepo);
    const sibling = await seedEndpoint(scopedRepo);
    const stranger = await seedEndpoint(otherRepo);

    // The sibling and the stranger are mid-run when the disablement happens, so
    // this asserts their state is not merely absent but UNCHANGED.
    await failTimes(scoped.id, scopedRepo, sibling.id, 2);
    await failTimes(other.id, otherRepo, stranger.id, 2);
    const siblingBefore = await runOf(sibling.id);
    const strangerBefore = await runOf(stranger.id);

    await failTimes(scoped.id, scopedRepo, doomed.id, 4);
    await ageRun(doomed.id, 64);
    await failTimes(scoped.id, scopedRepo, doomed.id, 1, 503);
    expect((await runOf(doomed.id)).enabled).toBe(false);

    expect(await runOf(sibling.id)).toEqual(siblingBefore);
    expect(await runOf(stranger.id)).toEqual(strangerBefore);
    expect(await notificationsFor(sibling.id)).toHaveLength(0);
    expect(await notificationsFor(stranger.id)).toHaveLength(0);
  }, 180_000);

  it("invariant 12: the SWEEP disables the quiet endpoint no outcome ever revisits", async () => {
    // THE TEST RESEARCH R1 EXISTS FOR, and the one most likely to be dropped as
    // redundant next to the on-outcome check above. It is not redundant: it is the
    // only test that covers the customer the requirement is actually about.
    //
    // Five failures, then SILENCE. The endpoint has crossed the floor and the hour,
    // and no further outcome will ever arrive — the delivery dead-lettered, or the
    // environment simply went quiet. An outcome-only check never fires again and
    // the endpoint stays enabled and failing for ever.
    const scoped = await mintEnvironment("disable-itest-sweep");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    await failTimes(scoped.id, scopedRepo, endpoint.id, 5, 503);
    await ageRun(endpoint.id, 64);

    // Still enabled: nothing has happened since, which is the whole point.
    expect((await runOf(endpoint.id)).enabled).toBe(true);

    const disabled = await sweepDisabledEndpoints(db);
    expect(disabled).toBeGreaterThanOrEqual(1);

    const after = await runOf(endpoint.id);
    expect(after.enabled).toBe(false);
    expect(after.disabled_at).not.toBeNull();
    // The sweep has no outcome in hand, so it read the last status off the
    // endpoint's most recent delivery. Without that it could only say "cause
    // unknown", which is the notification a support engineer would receive.
    expect(after.disabled_reason).toContain("last status 503");

    const notifications = await notificationsFor(endpoint.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.last_status).toBe(503);
    expect(notifications[0]!.delivered_at).toBeNull();
  }, 120_000);

  it("invariant 12: the sweep is idempotent against invariant 8", async () => {
    // Both triggers go through the same statement, so the sweep inherits the
    // at-most-once rule rather than reimplementing it. Running it twice must not
    // produce a second notification — and running it against an endpoint the
    // on-outcome path already disabled must find nothing to do.
    const scoped = await mintEnvironment("disable-itest-sweep2");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    await failTimes(scoped.id, scopedRepo, endpoint.id, 5, 503);
    await ageRun(endpoint.id, 64);

    await sweepDisabledEndpoints(db);
    await sweepDisabledEndpoints(db);
    await sweepDisabledEndpoints(db);

    expect(await notificationsFor(endpoint.id)).toHaveLength(1);
  }, 120_000);

  it("the sweep leaves a healthy endpoint and one still inside the hour alone", async () => {
    // The sweep runs several times a second in a live service, so what it does NOT
    // touch matters as much as what it does.
    const scoped = await mintEnvironment("disable-itest-sweep3");
    const scopedRepo = new Repository(db, scoped.id);
    const healthy = await seedEndpoint(scopedRepo);
    const recent = await seedEndpoint(scopedRepo);

    await failTimes(scoped.id, scopedRepo, recent.id, 5, 500);
    // Inside the hour: five failures, but the window has not elapsed.
    await ageRun(recent.id, 30);

    await sweepDisabledEndpoints(db);

    expect((await runOf(healthy.id)).enabled).toBe(true);
    expect((await runOf(recent.id)).enabled).toBe(true);
    expect(await notificationsFor(recent.id)).toHaveLength(0);
  }, 120_000);

  it("invariant 13: a test event's outcome never touches the run", async () => {
    // Written here rather than with the test-event route, because the property is
    // the repository's: a synthetic delivery's outcome must not open, extend or
    // clear a run. A failed test must not push an endpoint toward disablement, and
    // a successful one must not let a customer mask a real outage by testing until
    // it passes.
    const scoped = await mintEnvironment("disable-itest-synthetic");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    await failTimes(scoped.id, scopedRepo, endpoint.id, 3, 500);
    const before = await runOf(endpoint.id);
    expect(before.failure_run_attempts).toBe(3);

    // A synthetic delivery that FAILS: the run must not grow.
    const failing = (await deliveryFor(scoped.id, scopedRepo)).find(
      (r) => r.endpoint_id === endpoint.id,
    )!;
    await db.execute(
      `UPDATE webhook_deliveries SET synthetic = true WHERE id = '${failing.id}'`,
    );
    await recordAttemptOutcome(db, {
      deliveryId: failing.id,
      attempt: failing.attempt,
      status: 500,
      latencyMs: 7,
    });
    expect((await runOf(endpoint.id)).failure_run_attempts).toBe(3);

    // And one that SUCCEEDS: the run must not clear.
    const passing = (await deliveryFor(scoped.id, scopedRepo)).find(
      (r) => r.endpoint_id === endpoint.id,
    )!;
    await db.execute(
      `UPDATE webhook_deliveries SET synthetic = true WHERE id = '${passing.id}'`,
    );
    await recordAttemptOutcome(db, {
      deliveryId: passing.id,
      attempt: passing.attempt,
      status: 200,
      latencyMs: 7,
    });
    const after = await runOf(endpoint.id);
    expect(after.failure_run_attempts).toBe(3);
    expect(after.failure_run_started_at).toEqual(before.failure_run_started_at);
  }, 120_000);

  it("a failed test event writes no dead letter", async () => {
    // A dead letter is customer-visible, retained for seven days and replayable.
    // A test event is a diagnostic the customer already has the answer to, so
    // putting one there would offer an operator a "replay" button that re-sends a
    // test.
    const scoped = await mintEnvironment("disable-itest-nodl");
    const scopedRepo = new Repository(db, scoped.id);
    const endpoint = await seedEndpoint(scopedRepo);

    const rows = await deliveryFor(scoped.id, scopedRepo);
    const delivery = rows.find((r) => r.endpoint_id === endpoint.id)!;
    await db.execute(
      `UPDATE webhook_deliveries SET synthetic = true WHERE id = '${delivery.id}'`,
    );

    // One attempt and no schedule, so the first failure is the last.
    const result = await recordAttemptOutcome(db, {
      deliveryId: delivery.id,
      attempt: delivery.attempt,
      status: 500,
      latencyMs: 7,
    });
    expect(result.outcome).toBe("dead_lettered");

    const mine = (await scopedRepo.listDeadLetters()).filter(
      (d) => d.event_id === delivery.event_id,
    );
    expect(mine).toHaveLength(0);
  }, 60_000);
});

// The sweep as the RELAY runs it (chapter 3.6, T033's reason for existing).
//
// Everything above calls `sweepDisabledEndpoints` directly, which leaves the
// wrapper around it — the flag, the count log, the swallowed failure — measured by
// nothing. Research R11 predicted exactly this: "the sweep runs in the relay loop
// … easy to exercise in a way the instrument cannot see". Chapter 3.5 ignored the
// equivalent warning and found four red thresholds with the chapter otherwise
// finished.
describe("the sweep, through the relay that runs it", () => {
  let db: Db;

  /** A publisher that goes nowhere. The sweep does not publish, so a real one
   * would only give this test a broker to be flaky about. */
  const silentPublisher = {
    async publish() {},
    async close() {},
  };

  const captured = () => {
    const lines: Record<string, unknown>[] = [];
    return {
      lines,
      logger: createLogger("sweep-itest", (line) =>
        lines.push(JSON.parse(String(line)) as Record<string, unknown>),
      ),
    };
  };

  /** Same bookkeeping as the describe above, for the same reason: these tests
   * report failures, so the deliveries they create fall due again for ever. */
  const minted: string[] = [];

  beforeAll(() => {
    db = createDb(createPool());
  });

  afterAll(async () => {
    if (minted.length === 0) return;
    const list = minted.map((id) => `'${id}'`).join(",");
    await db.execute(
      `UPDATE webhook_deliveries SET state = 'dead'
        WHERE state = 'pending' AND environment_id IN (${list})`,
    );
  }, 60_000);

  const doomedEndpoint = async () => {
    const env = await createEnvironment(db, { name: `sweep-relay-${randomUUID().slice(0, 8)}` });
    minted.push(env.id);
    const repo = new Repository(db, env.id);
    const secret = mintSigningSecret();
    const endpoint = await repo.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(secret),
    });
    // Five failures against fresh deliveries, then age the run past the hour.
    for (let i = 0; i < 5; i++) {
      const eventId = randomUUID();
      await expandEventToDeliveries(db, {
        eventId,
        environmentId: env.id,
        type: "message.created",
        payload: { id: eventId, type: "message.created" },
      });
      const rows = await repo.listDeliveriesForEvent(eventId);
      const mine = rows.find((r) => r.endpoint_id === endpoint.id)!;
      await recordAttemptOutcome(db, {
        deliveryId: mine.id,
        attempt: mine.attempt,
        status: 500,
        latencyMs: 4,
      });
    }
    await db.execute(
      `UPDATE webhook_endpoints
          SET failure_run_started_at = now() - interval '64 minutes'
        WHERE id = '${endpoint.id}'`,
    );
    return endpoint;
  };

  const enabledOf = async (id: string) => {
    const { rows } = (await db.execute(
      `SELECT enabled FROM webhook_endpoints WHERE id = '${id}'`,
    )) as unknown as { rows: { enabled: boolean }[] };
    return rows[0]!.enabled;
  };

  it("disables through the relay and logs a count", async () => {
    const endpoint = await doomedEndpoint();
    const { logger, lines } = captured();
    const relay = createDeliveryRelay({
      db,
      publisher: silentPublisher,
      logger,
      sweepEnabled: true,
    });

    const disabled = await relay.sweepOnce();

    expect(disabled).toBeGreaterThanOrEqual(1);
    expect(await enabledOf(endpoint.id)).toBe(false);
    const logged = lines.filter((l) => l["msg"] === "webhooks.endpoints_disabled");
    expect(logged).toHaveLength(1);
    // A COUNT, never an endpoint id or a url — the log discipline every relay in
    // this workspace keeps (NFR-SEC-06).
    expect(logged[0]!["count"]).toBe(disabled);
    expect(JSON.stringify(logged)).not.toContain(endpoint.id);
  }, 120_000);

  it("does nothing at all with RELAY_DISABLE_SWEEP off", async () => {
    // Quickstart V6's first half. This is what an outcome-only check ships, and
    // reading it is the only way the second half means anything.
    const endpoint = await doomedEndpoint();
    const { logger, lines } = captured();
    const relay = createDeliveryRelay({
      db,
      publisher: silentPublisher,
      logger,
      sweepEnabled: false,
    });

    expect(await relay.sweepOnce()).toBe(0);
    // Still enabled, still failing, hours past the threshold. That is the bug.
    expect(await enabledOf(endpoint.id)).toBe(true);
    expect(lines).toHaveLength(0);
  }, 120_000);

  it("logs and swallows a sweep failure rather than stopping the loop", async () => {
    // An endpoint that should have been disabled and was not costs one more failed
    // delivery. A relay that stopped draining costs every customer's webhooks. So
    // the sweep's failure is logged and dropped, exactly as the drain's is.
    const { logger, lines } = captured();
    const relay = createDeliveryRelay({
      // A db whose every query fails. Closing a real pool would be a slower way to
      // say the same thing and would take the other tests' pool with it.
      db: {
        transaction: async () => {
          throw new Error("connection terminated unexpectedly");
        },
      } as unknown as Db,
      publisher: silentPublisher,
      logger,
      sweepEnabled: true,
    });

    expect(await relay.sweepOnce()).toBe(0);
    const failed = lines.filter((l) => l["msg"] === "webhooks.disable_sweep_failed");
    expect(failed).toHaveLength(1);
    expect(String(failed[0]!["error"])).toContain("connection terminated");
  });

  it("logs nothing when there is nothing to disable", async () => {
    // This runs several times a second in a live service. A line per pass would
    // bury every other line the api writes.
    const { logger, lines } = captured();
    const relay = createDeliveryRelay({
      db,
      publisher: silentPublisher,
      logger,
      sweepEnabled: true,
    });

    // Whatever the shared database holds, a second sweep immediately after a first
    // has nothing left that is both eligible and enabled.
    await relay.sweepOnce();
    lines.length = 0;
    expect(await relay.sweepOnce()).toBe(0);
    expect(lines).toHaveLength(0);
  }, 120_000);
});

// What the LOCK protects, as opposed to what the predicate protects (chapter 3.6).
//
// These two tests exist because the sabotage battery contradicted a comment. The
// claim was that `SELECT … FOR UPDATE` on the endpoint row is what stops a
// concurrent pair of failures producing two disablements and two notifications.
// Dropping the lock and running the whole suite produced 46 passes: the
// `enabled = true` predicate in the disable statement is sufficient for that on its
// own, and the lock was not the mechanism being credited.
//
// The lock's real job is the COUNTER. Under READ COMMITTED, two transactions both
// read `failure_run_attempts = 4`, both compute 5, and the second UPDATE waits for
// the first and then overwrites it with 5 — a lost update, and the run undercounts.
// An undercount does not disable anything wrongly; it delays a disablement, which
// is FR-007's floor being quietly harder to reach than it says.
describe("the failure run under concurrency", () => {
  let db: Db;
  const minted: string[] = [];

  beforeAll(() => {
    db = createDb(createPool());
  });

  afterAll(async () => {
    if (minted.length === 0) return;
    const list = minted.map((id) => `'${id}'`).join(",");
    await db.execute(
      `UPDATE webhook_deliveries SET state = 'dead'
        WHERE state = 'pending' AND environment_id IN (${list})`,
    );
  }, 60_000);

  const twoPendingDeliveries = async () => {
    const env = await createEnvironment(db, {
      name: `run-concurrency-${randomUUID().slice(0, 8)}`,
    });
    minted.push(env.id);
    const repo = new Repository(db, env.id);
    const endpoint = await repo.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(mintSigningSecret()),
    });
    const made: { id: string; attempt: number }[] = [];
    for (let i = 0; i < 2; i++) {
      const eventId = randomUUID();
      await expandEventToDeliveries(db, {
        eventId,
        environmentId: env.id,
        type: "message.created",
        payload: { id: eventId, type: "message.created" },
      });
      const rows = await repo.listDeliveriesForEvent(eventId);
      const mine = rows.find((r) => r.endpoint_id === endpoint.id)!;
      made.push({ id: mine.id, attempt: mine.attempt });
    }
    return { endpoint, deliveries: made };
  };

  const attemptsOf = async (endpointId: string) => {
    const { rows } = (await db.execute(
      `SELECT failure_run_attempts FROM webhook_endpoints WHERE id = '${endpointId}'`,
    )) as unknown as { rows: { failure_run_attempts: number | null }[] };
    return rows[0]!.failure_run_attempts;
  };

  it("counts BOTH of two overlapping failures — the lost update the lock prevents", async () => {
    const { endpoint, deliveries } = await twoPendingDeliveries();

    await Promise.all(
      deliveries.map((d) =>
        recordAttemptOutcome(db, {
          deliveryId: d.id,
          attempt: d.attempt,
          status: 500,
          latencyMs: 3,
        }),
      ),
    );

    // TWO, not one. Without `FOR UPDATE` this reads 1: both transactions see a null
    // run, both compute 1, and the second write overwrites the first. The endpoint
    // then needs an extra failure to reach the floor, for ever, and nothing
    // anywhere reports that the count is wrong.
    expect(await attemptsOf(endpoint.id)).toBe(2);
  }, 60_000);

  it("still disables only once when the pair crosses the threshold together", async () => {
    // The other half, and the one the battery showed is NOT the lock's doing: the
    // `enabled = true` predicate in the disable statement means the second
    // transaction updates zero rows and writes no notification, lock or no lock.
    // Kept as a test because the property is required (invariant 8) whatever
    // enforces it — and the battery is how we found out which mechanism does.
    const { endpoint, deliveries } = await twoPendingDeliveries();
    await db.execute(
      `UPDATE webhook_endpoints
          SET failure_run_started_at = now() - interval '64 minutes',
              failure_run_attempts = 4
        WHERE id = '${endpoint.id}'`,
    );

    await Promise.all(
      deliveries.map((d) =>
        recordAttemptOutcome(db, {
          deliveryId: d.id,
          attempt: d.attempt,
          status: 503,
          latencyMs: 3,
        }),
      ),
    );

    const { rows } = (await db.execute(
      `SELECT count(*)::int AS n FROM webhook_disable_notifications
        WHERE endpoint_id = '${endpoint.id}'`,
    )) as unknown as { rows: { n: number }[] };
    expect(rows[0]!.n).toBe(1);
  }, 60_000);
});

// That the LOOP calls the sweep (chapter 3.6, T026).
//
// Also a finding of the sabotage battery: deleting the `await sweepOnce()` line
// from the relay's `run()` loop broke nothing, because every test above calls
// `sweepOnce` or `sweepDisabledEndpoints` directly. The sweep was tested and its
// PLACE in the loop was not, which is the same shape as chapter 3.5's vacuous
// "terminated, not retried" assertion — the mechanism was covered and the wiring
// was not.
describe("the relay's loop sweeps without being asked", () => {
  let db: Db;
  const minted: string[] = [];

  beforeAll(() => {
    db = createDb(createPool());
  });

  afterAll(async () => {
    if (minted.length === 0) return;
    const list = minted.map((id) => `'${id}'`).join(",");
    await db.execute(
      `UPDATE webhook_deliveries SET state = 'dead'
        WHERE state = 'pending' AND environment_id IN (${list})`,
    );
  }, 60_000);

  it("disables an endpoint with nothing but start() and time", async () => {
    const env = await createEnvironment(db, {
      name: `loop-sweep-${randomUUID().slice(0, 8)}`,
    });
    minted.push(env.id);
    const repo = new Repository(db, env.id);
    const endpoint = await repo.createEndpoint({
      url: `https://example.test/${randomUUID()}`,
      eventTypes: ["message.created"],
      secretCiphertext: encryptSecret(mintSigningSecret()),
    });
    await db.execute(
      `UPDATE webhook_endpoints
          SET failure_run_started_at = now() - interval '64 minutes',
              failure_run_attempts = 6
        WHERE id = '${endpoint.id}'`,
    );

    const relay = createDeliveryRelay({
      db,
      publisher: { async publish() {}, async close() {} },
      logger: createLogger("loop-sweep-itest", () => {}),
      // Fast, because this test waits on a real timer rather than pretending.
      intervalMs: 50,
    });

    // START, and then nothing. No `sweepOnce`, no `drainOnce` — the loop is the
    // only thing that can disable this endpoint, which is the point.
    relay.start();
    try {
      const deadline = Date.now() + 20_000;
      let enabled = true;
      while (enabled && Date.now() < deadline) {
        const { rows } = (await db.execute(
          `SELECT enabled FROM webhook_endpoints WHERE id = '${endpoint.id}'`,
        )) as unknown as { rows: { enabled: boolean }[] };
        enabled = rows[0]!.enabled;
        if (enabled) await new Promise((r) => setTimeout(r, 100));
      }
      expect(enabled).toBe(false);
    } finally {
      await relay.stop();
    }
  }, 60_000);
});
