import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, createPool, type Db } from "../db/client";
import {
  createEnvironment,
  drainDueDeliveries,
  expandEventToDeliveries,
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
