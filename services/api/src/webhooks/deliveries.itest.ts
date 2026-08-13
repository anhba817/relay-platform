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
  timesHandled,
} from "../db/repository";
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
