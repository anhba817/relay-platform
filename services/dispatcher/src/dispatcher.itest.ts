import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect, DeliverPolicy, type NatsConnection } from "nats";
import { subjectFor } from "@relay/protocol";

import { ACK_WAIT_MS, createDispatcher, type Dispatcher } from "./main.js";

// The dispatcher against a real api, a real broker and a real customer endpoint
// (chapter 3.5). Invariant 7 lives here; 11, 13, 15 and 16 join it.
//
// The api runs as a CHILD PROCESS, not in-process — the same choice the
// gateway's socket suite made in 3.2 and for the same reason. The dispatcher's
// whole point is that it reaches state over the internal seam rather than
// through a database client, and a suite that imported the api's modules would
// prove that over a function call instead of over HTTP.

const encoder = new TextEncoder();
const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const API_DIST = join(REPO, "services", "api", "dist");

const CREDENTIAL =
  process.env["RELAY_INTERNAL_CREDENTIAL"] ??
  "rk_svc_dispatcher_itest_0123456789abcdef";

interface Seeded {
  environmentId: string;
  endpointId: string;
  secret: string;
}

/** A customer's server. Records what arrives and answers however the test says.
 * The same shape `scripts/hostile-endpoint.mjs` gives a reader by hand. */
function customerEndpoint() {
  const received: { headers: Record<string, string>; body: string; at: number }[] =
    [];
  let reply: number | "hang" = 200;
  const held: import("node:http").ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      received.push({
        headers: req.headers as Record<string, string>,
        body,
        at: Date.now(),
      });
      if (reply === "hang") {
        // Accepts the request and never answers. The failure mode a timeout
        // exists for, and the one a customer never notices on their side.
        held.push(res);
        return;
      }
      res.writeHead(reply).end("ok");
    });
  });
  return {
    received,
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, () => {
          const addr = server.address();
          resolve(
            `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
          );
        }),
      ),
    answerWith: (status: number | "hang") => {
      reply = status;
    },
    close: () => {
      for (const res of held) res.destroy();
      server.close();
    },
  };
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("api never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The api, as a child process. Extracted so invariant 11 can kill it and start
 * a new one — the point of that test is that neither process holds the retry
 * schedule, and a suite that could not restart the api could not show it. */
function spawnApi(port: number, credential: string): ChildProcess {
  return spawn("node", [join(API_DIST, "main.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_INTERNAL_CREDENTIAL: credential,
      // Chapter 3.3's finding 4, for the third time: this suite drives the relay
      // explicitly, so a background copy draining the same table would race it.
      RELAY_OUTBOX_RELAY: "off",
      RELAY_EVENT_CONSUMER: "off",
      RELAY_DELIVERY_RELAY: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Keeps every line the dispatcher writes, so invariant 15 can assert on the
 * logs themselves rather than on the request that went out. A secret leaks into
 * an operator's terminal through a log line, not through a header. */
function capturingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      log(level: "info" | "error", msg: string, fields?: Record<string, unknown>) {
        lines.push(JSON.stringify({ level, msg, ...(fields ?? {}) }));
      },
    },
  };
}

describe("the dispatcher", () => {
  let child: ChildProcess;
  let apiUrl: string;
  let apiPort: number;
  /** The per-run durable names. A restarted dispatcher must reuse them — a
   * durable IS a position, and taking a new name would be starting over rather
   * than resuming. */
  let durables: { expand: string; deliver: string };
  const captured = capturingLogger();
  let dispatcher: Dispatcher;
  let endpoint: ReturnType<typeof customerEndpoint>;
  /** A second customer, so "does not delay deliveries to OTHER endpoints" has an
   * other to be delayed. */
  let second: ReturnType<typeof customerEndpoint>;
  let secondUrl: string;
  /** Short on purpose: the isolation property is about whether a healthy
   * endpoint waits behind a hanging one, and ten real seconds per assertion buys
   * nothing but a slower suite. */
  const TEST_TIMEOUT_MS = 2_000;
  const ACK_WAIT_TEST_MS = 4_000;
  let seeder: {
    createEnvironment: (db: unknown, o: { name: string }) => Promise<{ id: string }>;
    Repository: new (db: unknown, envId: string) => {
      createEndpoint: (i: {
        url: string;
        eventTypes: string[];
        secretCiphertext: string;
      }) => Promise<{ id: string }>;
      deleteEndpoint: (id: string) => Promise<boolean>;
      listDeliveriesForEvent: (
        eventId: string,
      ) => Promise<
        {
          id: string;
          attempt: number;
          state: string;
          next_attempt_at: string;
          dispatched_at: string | null;
        }[]
      >;
    };
    expandEventToDeliveries: (db: unknown, e: unknown) => Promise<unknown>;
    drainDueDeliveries: (
      db: unknown,
      n: number,
      f: (r: unknown) => Promise<void>,
    ) => Promise<number>;
  };
  let secrets: { encryptSecret: (s: string) => string; mintSigningSecret: () => string };
  /** The real tier table, loaded from the api's build like everything else here
   * — the api is CommonJS and this package is ESM (ADR-15's dialect split), so
   * importing its source directly is not available to us. */
  let retryTiersMs: number[];
  let db: unknown;
  /** Only the expansion tests need one, so it is opened lazily and drained in
   * `afterAll` — an undrained connection keeps the process alive past the run. */
  let nats: NatsConnection | null = null;
  const NATS_URL = process.env["RELAY_NATS_URL"] ?? "nats://localhost:4222";

  const seed = async (eventTypes: string[], url?: string): Promise<Seeded> => {
    const env = await seeder.createEnvironment(db, {
      name: `dispatcher-itest-${randomUUID().slice(0, 8)}`,
    });
    const repo = new seeder.Repository(db, env.id);
    const secret = secrets.mintSigningSecret();
    const created = await repo.createEndpoint({
      url: `${url ?? (await endpointUrl)}/hook`,
      eventTypes,
      secretCiphertext: secrets.encryptSecret(secret),
    });
    return { environmentId: env.id, endpointId: created.id, secret };
  };

  let endpointUrl: Promise<string>;

  /** Poll until the expectation holds, or the deadline passes. Bounded, so a
   * genuine failure is a failure rather than a hang — and a negative assertion
   * ("nothing should arrive") simply spends the whole budget and moves on. */
  const pollUntil = async (
    done: () => boolean | Promise<boolean>,
    timeoutMs = 8_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    // Awaited, so a predicate that has to ASK the database — "are the delivery
    // rows there yet?" — works as naturally as one that reads an array.
    while (!(await done()) && Date.now() < deadline) {
      await dispatcher.pollOnce();
    }
  };

  /** The captured log lines are JSON strings; this is the read side. */
  const logged = (msg: string): Record<string, unknown>[] =>
    captured.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l["msg"] === msg);

  /** Publish a real event onto the EVENTS stream, exactly as chapter 3.3's
   * outbox relay does.
   *
   * WHY THIS EXISTS. Every other helper in this file reaches expansion by
   * calling `expandEventToDeliveries` against the database directly — fine for a
   * suite about DELIVERY, which is what those tests are about, but it meant the
   * dispatcher's own expand consumer was never once executed by its own suite.
   * Coverage said so plainly: `expand.ts`, 0%. The tests below go in through the
   * broker instead, so the consumer that decodes an event, asks the api to
   * expand it, and decides ack-or-terminate is actually the thing under test. */
  const publishEvent = async (
    subject: string,
    bytes: Uint8Array,
  ): Promise<void> => {
    nats ??= await connect({ servers: NATS_URL });
    await nats.jetstream().publish(subject, bytes);
  };

  /** Run the api's delivery relay once: everything due goes onto the stream.
   * The real loop, driven explicitly — this suite turns the background copy off
   * so the two cannot race (chapter 3.3's finding 4, third occurrence). */
  const publishDue = async (): Promise<number> => {
    const relay = require_(join(API_DIST, "webhooks", "delivery-relay.js")) as {
      createDeliveryRelay: (o: unknown) => { drainOnce: () => Promise<number> };
      ensureDeliveriesStream: unknown;
    };
    const publisherMod = require_(
      join(API_DIST, "outbox", "jetstream.publisher.js"),
    ) as { createJetStreamPublisher: (o: unknown) => unknown };
    const kit = require_(
      join(REPO, "packages", "service-kit", "dist", "index.js"),
    ) as { createLogger: (n: string) => unknown };
    const r = relay.createDeliveryRelay({
      db,
      publisher: publisherMod.createJetStreamPublisher({
        ensure: relay.ensureDeliveriesStream,
      }),
      logger: kit.createLogger("itest-relay"),
      // A BATCH BIG ENOUGH TO REACH THIS TEST'S OWN DELIVERY. `drainOnce` is
      // global: it takes the fifty oldest due deliveries in the platform,
      // oldest first, and this suite's is the newest. Every earlier suite in the
      // run leaves due deliveries behind, so once more than fifty of them
      // accumulate the batch fills before reaching ours, the poll times out at
      // eight seconds, and `expected 0 to be greater than 0` is what a reader
      // sees.
      //
      // It only bites in the COVERAGE lane, where `fileParallelism: false` puts
      // every suite in one process against one database. The failing run drains
      // the backlog itself, so the next run passes — which is why it reads as a
      // flake rather than as the threshold it is.
      //
      // Found at chapter 3.8's baseline. Chapter 3.7 fixed the same global drain
      // in `deliveries.itest.ts` twice and never looked at this door.
      batchSize: 10_000,
    });
    return r.drainOnce();
  };

  /** As `deliverEvent`, but with a tenant's message text in the payload — so
   * invariant 15 has something that must NOT appear in a log line. */
  const deliverEventWithText = async (
    seeded: Seeded,
    text: string,
  ): Promise<void> => {
    const seenBefore = endpoint.received.length;
    const eventId = randomUUID();
    await seeder.expandEventToDeliveries(db, {
      eventId,
      environmentId: seeded.environmentId,
      type: "message.created",
      payload: {
        id: eventId,
        type: "message.created",
        environment_id: seeded.environmentId,
        data: { id: randomUUID(), seq: 1, user: "tuan", text },
      },
    });
    await publishDue();
    await pollUntil(() => endpoint.received.length > seenBefore);
  };

  /** Publish an event, let the relay put its due deliveries on the stream, then
   * run one dispatcher pass — the same code path `start()` runs. */
  const deliverEvent = async (
    seeded: Seeded,
    type: string,
  ): Promise<{ eventId: string }> => {
    const seenBefore = endpoint.received.length;
    const eventId = randomUUID();
    await seeder.expandEventToDeliveries(db, {
      eventId,
      environmentId: seeded.environmentId,
      type,
      payload: {
        id: eventId,
        type,
        environment_id: seeded.environmentId,
        occurred_at: new Date().toISOString(),
        data: { id: randomUUID(), seq: 1, user: "tuan", text: "B2, north ramp" },
      },
    });
    await publishDue();
    // POLL, don't peek. A single pass races the broker: `fetch` returns whatever
    // is available at that instant, and a message published a moment earlier may
    // not be yet. Production polls in a loop, so a test that polls once is
    // testing something the service never does — and it fails intermittently,
    // which is worse than failing.
    await pollUntil(() => endpoint.received.length > seenBefore);
    return { eventId };
  };

  beforeAll(async () => {
    if (!existsSync(join(API_DIST, "main.js"))) {
      throw new Error(
        "the api is not built — run `pnpm build` before this lane " +
          "(the suite talks to the real service over HTTP, not a stub)",
      );
    }
    const client = require_(join(API_DIST, "db", "client.js")) as {
      createDb: (p: unknown) => unknown;
      createPool: () => unknown;
    };
    seeder = require_(join(API_DIST, "db", "repository.js")) as typeof seeder;
    secrets = require_(join(API_DIST, "webhooks", "secret.js")) as typeof secrets;
    retryTiersMs = (
      require_(join(API_DIST, "webhooks", "schedule.js")) as { RETRY_TIERS_MS: number[] }
    ).RETRY_TIERS_MS;
    db = client.createDb(client.createPool());

    endpoint = customerEndpoint();
    endpointUrl = endpoint.listen();
    await endpointUrl;

    second = customerEndpoint();
    secondUrl = await second.listen();

    apiPort = Number(process.env["RELAY_DISPATCHER_ITEST_API_PORT"] ?? 4131);
    child = spawnApi(apiPort, CREDENTIAL);
    apiUrl = `http://127.0.0.1:${apiPort}`;
    await waitForHealth(`${apiUrl}/healthz`);
    // A per-run position, and only messages published after it exists. Sharing
    // the production durable would hand this suite every delivery every earlier
    // run left behind — and a batch of twenty-five is quickly all backlog, which
    // is exactly how this suite first failed. Chapter 2.1 did the same for
    // environments, 2.6 for subjects, 3.4 for its own durables.
    const run = randomUUID().slice(0, 8);
    durables = { expand: `itest-expand-${run}`, deliver: `itest-deliver-${run}` };
    dispatcher = createDispatcher({
      apiUrl,
      credential: CREDENTIAL,
      attemptTimeoutMs: TEST_TIMEOUT_MS,
      durables,
      deliverPolicy: DeliverPolicy.New,
      // ONLY the expand consumer is shortened, so "an unacknowledged message
      // comes back" is observable inside a test's patience. The deliver
      // consumer keeps the production window: its attempts run to a timeout,
      // and a short window there makes the broker redeliver work that is still
      // in progress — which is how this suite briefly delivered two webhooks to
      // one customer under the coverage lane's slower clock.
      ackWaitMs: { expand: ACK_WAIT_TEST_MS, deliver: ACK_WAIT_MS },
      logger: captured.logger,
    });
    // Created BEFORE anything is published, or "New" would skip the first event.
    await dispatcher.ready();
  }, 60_000);

  afterAll(async () => {
    await dispatcher?.stop();
    if (nats && !nats.isClosed()) await nats.drain();
    child?.kill();
    endpoint?.close();
    second?.close();
  });

  it("invariant 7: delivers an event the endpoint subscribes to", async () => {
    endpoint.answerWith(200);
    const seeded = await seed(["message.created"]);
    const before = endpoint.received.length;

    await deliverEvent(seeded, "message.created");

    expect(endpoint.received.length).toBeGreaterThan(before);
  });

  it("invariant 7: delivers nothing for an event type it does not subscribe to", async () => {
    endpoint.answerWith(200);
    const seeded = await seed(["channel.created"]);
    const before = endpoint.received.length;

    await deliverEvent(seeded, "message.created");

    // Filtered at EXPANSION, so there is no delivery row at all — not a row that
    // exists and is never sent, which would be a permanent no-op in the retry
    // schedule that an operator could not tell from work that is stuck.
    expect(endpoint.received.length).toBe(before);
  });

  it("invariant 16: the delivered body is 3.3's envelope and carries the event id", async () => {
    endpoint.answerWith(200);
    const seeded = await seed(["message.created"]);

    const { eventId } = await deliverEvent(seeded, "message.created");

    const last = endpoint.received.at(-1)!;
    const body = JSON.parse(last.body) as { id: string; type: string };
    // The field every claim this chapter makes about at-least-once rests on: the
    // identifier a customer deduplicates the accepted duplicate on.
    expect(body.id).toBe(eventId);
    expect(body.type).toBe("message.created");
  });

  it("invariant 15: no log line carries a signing secret or a message body", async () => {
    // NFR-SEC-06, and the reason it is asserted against the LOGS rather than the
    // outgoing request: a secret reaches an operator's terminal through a log
    // line. The header assertion below is the easy half; the log line is the one
    // a well-meaning "just for debugging" change would break.
    //
    // Driven through the ERROR PATHS on purpose — a success path rarely prints
    // what it was working with, and an error path frequently does.
    const body = "B2, north ramp — a tenant's message text";

    // 1. a success
    endpoint.answerWith(200);
    const ok = await seed(["message.created"]);
    await deliverEventWithText(ok, body);

    // 2. a customer failure
    endpoint.answerWith(500);
    const failing = await seed(["message.created"]);
    await deliverEventWithText(failing, body);

    // 3. a customer that hangs, so the timeout path logs too
    endpoint.answerWith("hang");
    const hanging = await seed(["message.created"]);
    await deliverEventWithText(hanging, body);
    endpoint.answerWith(200);

    expect(captured.lines.length).toBeGreaterThan(0);
    const all = captured.lines.join("\n");
    for (const seeded of [ok, failing, hanging]) {
      expect(all).not.toContain(seeded.secret);
    }
    // Nor a tenant's message text. Identifiers, counts and durations are the
    // whole vocabulary of these lines.
    expect(all).not.toContain(body);
  });

  it("invariant 15: no request header carries the secret either", async () => {
    endpoint.answerWith(200);
    const seeded = await seed(["message.created"]);

    await deliverEvent(seeded, "message.created");

    const last = endpoint.received.at(-1)!;
    // The signature travels; the secret never does. A header carrying the shared
    // secret would hand it to anyone who can read one request.
    expect(JSON.stringify(last.headers)).not.toContain(seeded.secret);
    expect(last.body).not.toContain(seeded.secret);
  });

  it("invariant 13: a hanging endpoint is abandoned on the timeout", async () => {
    endpoint.answerWith("hang");
    const seeded = await seed(["message.created"]);

    const started = Date.now();
    await deliverEvent(seeded, "message.created");
    const elapsed = Date.now() - started;

    // Abandoned, not waited on forever. The customer accepted the request and
    // never answered — the failure a timeout exists for, and the one they never
    // notice on their side.
    expect(endpoint.received.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(TEST_TIMEOUT_MS * 3);
    endpoint.answerWith(200);
  });

  it("invariant 13: a hanging endpoint does not delay deliveries to another", async () => {
    // THE CLAUSE FR-WHK-05 ACTUALLY CARES ABOUT. "Abandoned on the timeout" is
    // the easy half; this is the half that fails if deliveries are processed one
    // after another, because the healthy customer then waits out somebody else's
    // silence before hearing anything at all.
    endpoint.answerWith("hang");
    second.answerWith(200);

    const hanging = await seed(["message.created"]);
    const healthy = await seed(["message.created"], secondUrl);

    // ORDER MATTERS, and the test is worthless without fixing it. The relay
    // drains by `next_attempt_at, id`, so expanding the hanging endpoint FIRST
    // puts it at the head of the batch. If deliveries were processed one after
    // another, the healthy customer would then sit behind a full timeout it had
    // nothing to do with — which is precisely the failure being ruled out.
    //
    // Left unordered, this test passes whether or not the isolation exists: with
    // sequential processing the healthy delivery might simply happen to go
    // first. That was the first version, and the sabotage check caught it.
    await seeder.expandEventToDeliveries(db, {
      eventId: randomUUID(),
      environmentId: hanging.environmentId,
      type: "message.created",
      payload: { id: randomUUID(), type: "message.created" },
    });
    await seeder.expandEventToDeliveries(db, {
      eventId: randomUUID(),
      environmentId: healthy.environmentId,
      type: "message.created",
      payload: { id: randomUUID(), type: "message.created" },
    });
    await publishDue();

    const hangingBefore = endpoint.received.length;
    const healthyBefore = second.received.length;
    await dispatcher.pollOnce();

    expect(endpoint.received.length).toBeGreaterThan(hangingBefore);
    expect(second.received.length).toBeGreaterThan(healthyBefore);

    // THE PROPERTY, and it does not depend on how long the setup took: the
    // healthy customer heard from us while the other request was still hanging.
    // The hanging endpoint is first in the batch, so sequential processing would
    // put this arrival a whole timeout later.
    const hangingAt = endpoint.received.at(-1)!.at;
    const healthyAt = second.received.at(-1)!.at;
    expect(healthyAt - hangingAt).toBeLessThan(TEST_TIMEOUT_MS / 2);

    endpoint.answerWith(200);
  });

  it("invariant 11: a pending retry survives a restart of BOTH processes", async () => {
    // THE INVARIANT THAT DECIDED THE DESIGN.
    //
    // Research R1 measured the obvious implementation — a broker-held delay —
    // and found it durable to within 3 ms but fatal in aggregate: a waiting
    // message holds an acknowledgement slot, so dead endpoints starve healthy
    // ones. The schedule became a `next_attempt_at` column instead.
    //
    // The consequence is this test. A row is held by NEITHER process, so both
    // can be destroyed between an attempt and its retry and the retry still
    // falls due. Under the broker-held design the api's restart would not even
    // have been a question — the api held nothing. Now it holds everything, and
    // may still be killed.
    //
    // WHAT THIS ASSERTS, precisely: that the SCHEDULE survives and becomes
    // claimable again. That the claimed delivery then reaches the customer is
    // invariants 7 and 13's subject, proven against this same endpoint above;
    // repeating it here would tangle the schedule's durability with the
    // dispatcher's stream position, which is a different property with a
    // different failure mode.
    endpoint.answerWith(500);
    const seeded = await seed(["message.created"]);
    const repo = new seeder.Repository(db, seeded.environmentId);

    // Attempt 1 fails, so attempt 2 is scheduled one second out.
    const { eventId } = await deliverEvent(seeded, "message.created");
    const [afterAttempt1] = await repo.listDeliveriesForEvent(eventId);
    expect(afterAttempt1!.attempt).toBe(2);
    expect(afterAttempt1!.state).toBe("pending");

    // Destroy BOTH processes. Nothing in memory anywhere survives this.
    await dispatcher.stop();
    child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 250));
    child = spawnApi(apiPort, CREDENTIAL);
    await waitForHealth(`${apiUrl}/healthz`);

    // The schedule is exactly where it was, in a database neither process was
    // holding — same tier, same due time, still unclaimed.
    const [survived] = await repo.listDeliveriesForEvent(eventId);
    expect(survived!.attempt).toBe(2);
    expect(survived!.state).toBe("pending");
    expect(survived!.next_attempt_at).toBe(afterAttempt1!.next_attempt_at);
    expect(survived!.dispatched_at).toBeNull();

    // And when the tier falls due, the relay in the RESTARTED api claims it —
    // so the retry is live again, not merely remembered.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await publishDue();

    const [claimed] = await repo.listDeliveriesForEvent(eventId);
    expect(claimed!.dispatched_at).not.toBeNull();

    endpoint.answerWith(200);
    // Leave a working dispatcher behind for anything that runs after this.
    dispatcher = createDispatcher({
      apiUrl,
      credential: CREDENTIAL,
      attemptTimeoutMs: TEST_TIMEOUT_MS,
      durables,
      deliverPolicy: DeliverPolicy.New,
      logger: captured.logger,
    });
    await dispatcher.ready();
  });

  it("invariant 14: a backlog accumulated while not consuming drains when it resumes", async () => {
    // The other half of invariant 14. The e2e journey shows end users are served
    // while the dispatcher does not exist; this shows the work it was not doing
    // was WAITING rather than lost.
    //
    // "Absent" is modelled as NOT CONSUMING, which is what absence means to a
    // durable consumer: the position stays where it is and the stream keeps the
    // messages. Process lifecycle — killing and restarting both services — is
    // invariant 11's subject, and it holds the schedule rather than the stream.
    endpoint.answerWith(200);
    const seeded = await seed(["message.created"]);
    const before = endpoint.received.length;

    // Three events expand and become due, and the relay puts them on the stream.
    // Nothing consumes in this stretch.
    const events = [randomUUID(), randomUUID(), randomUUID()];
    for (const eventId of events) {
      await seeder.expandEventToDeliveries(db, {
        eventId,
        environmentId: seeded.environmentId,
        type: "message.created",
        payload: { id: eventId, type: "message.created" },
      });
    }
    await publishDue();

    // Consuming resumes. The backlog is on the stream and the deliveries are
    // rows; neither needed the dispatcher to be watching.
    const deadline = Date.now() + 30_000;
    while (
      endpoint.received.length - before < events.length &&
      Date.now() < deadline
    ) {
      await dispatcher.pollOnce();
    }

    expect(endpoint.received.length - before).toBeGreaterThanOrEqual(
      events.length,
    );
  }, 90_000);
  // ---------------------------------------------------------------------------
  // The EXPAND consumer, driven through the broker.
  //
  // These three are the reason `publishEvent` exists. Everything above reaches
  // the delivery path by seeding rows; nothing above ever ran `expand.ts`.
  // ---------------------------------------------------------------------------

  it("invariant 8: one event becomes one delivery per matching endpoint", async () => {
    endpoint.answerWith(200);
    // Two endpoints in ONE environment, subscribed to the same type. The
    // fan-out is the property: N endpoints, N delivery rows, one event.
    const seeded = await seed(["message.created"]);
    const repo = new seeder.Repository(db, seeded.environmentId);
    await repo.createEndpoint({
      url: `${secondUrl}/hook`,
      eventTypes: ["message.created"],
      secretCiphertext: secrets.encryptSecret(secrets.mintSigningSecret()),
    });
    // A third endpoint that subscribes to something else, so "matching" is
    // doing work rather than being satisfied by every endpoint in the row.
    await repo.createEndpoint({
      url: `${secondUrl}/unwanted`,
      eventTypes: ["channel.created"],
      secretCiphertext: secrets.encryptSecret(secrets.mintSigningSecret()),
    });

    const eventId = randomUUID();
    await publishEvent(
      subjectFor("message.created", seeded.environmentId),
      encoder.encode(
        JSON.stringify({
          id: eventId,
          type: "message.created",
          environment_id: seeded.environmentId,
          occurred_at: new Date().toISOString(),
          data: { id: randomUUID(), seq: 1, user: "tuan", text: "north ramp" },
        }),
      ),
    );

    // The DISPATCHER expands it — no direct database write anywhere in this test.
    let rows: Awaited<ReturnType<typeof repo.listDeliveriesForEvent>> = [];
    await pollUntil(async () => {
      rows = await repo.listDeliveriesForEvent(eventId);
      return rows.length >= 2;
    });

    expect(rows).toHaveLength(2);
  }, 60_000);

  it("invariant 9: a redelivered event does not double the customer's webhooks", async () => {
    endpoint.answerWith(200);
    const seeded = await seed(["message.created"]);
    const repo = new seeder.Repository(db, seeded.environmentId);

    const eventId = randomUUID();
    const bytes = encoder.encode(
      JSON.stringify({
        id: eventId,
        type: "message.created",
        environment_id: seeded.environmentId,
        occurred_at: new Date().toISOString(),
        data: { id: randomUUID(), seq: 1, user: "tuan", text: "B2" },
      }),
    );
    const subject = subjectFor("message.created", seeded.environmentId);

    // The SAME event id, twice. This is what a broker redelivery looks like from
    // the consumer's side, and research R2's claim is that the api's claim
    // transaction absorbs it: the second expansion creates nothing.
    await publishEvent(subject, bytes);
    let rows: Awaited<ReturnType<typeof repo.listDeliveriesForEvent>> = [];
    await pollUntil(async () => {
      rows = await repo.listDeliveriesForEvent(eventId);
      return rows.length >= 1;
    });
    expect(rows).toHaveLength(1);

    await publishEvent(subject, bytes);
    await pollUntil(() => false, 2_000); // spend the budget; nothing to wait for

    // Still one. A second row here would be a second webhook to a customer who
    // was promised one, which is the failure this whole design is built around.
    expect(await repo.listDeliveriesForEvent(eventId)).toHaveLength(1);
    expect(logged("expand.done").some((l) => l["duplicate"] === true)).toBe(true);
  }, 60_000);

  it("bytes that can never parse are terminated on the first attempt", async () => {
    const seeded = await seed(["message.created"]);
    // Not JSON at all. `msg.json()` throws, and the consumer must TERMINATE
    // rather than leave it unacknowledged — the same bytes fail the same way
    // every time, so redelivering them spends the broker's attempt budget to
    // reach a conclusion that was available on the first pass (chapter 3.4).
    await publishEvent(
      subjectFor("message.created", seeded.environmentId),
      encoder.encode("{ this is not json"),
    );

    await pollUntil(() => logged("expand.undecodable").length > 0);
    expect(logged("expand.undecodable").length).toBeGreaterThan(0);

    // Terminated, so it does not come back — and the window below outlasts
    // `ackWaitMs`, which is the only reason this assertion can fail. Left
    // unacknowledged, the broker would hand it back and the count would climb.
    const seen = logged("expand.undecodable").length;
    await pollUntil(() => false, ACK_WAIT_TEST_MS + 3_000);
    expect(logged("expand.undecodable").length).toBe(seen);
  }, 60_000);
  it("JSON that is not an envelope is terminated too, not retried", async () => {
    const seeded = await seed(["message.created"]);
    // Parses cleanly, so it gets past `msg.json()` — and then fails the SHAPE
    // check inside `parseEventEnvelope`, which is a different rejection at a
    // different layer. Chapter 2.5's reason for parsing rather than trusting: a
    // message that has been sitting in a stream has had time to stop matching
    // the code that reads it, and "it was valid JSON" is not the same as "it is
    // still an event".
    await publishEvent(
      subjectFor("message.created", seeded.environmentId),
      encoder.encode(JSON.stringify({ id: randomUUID(), type: "message.created" })),
    );

    await pollUntil(() => logged("expand.unparseable").length > 0);
    expect(logged("expand.unparseable").length).toBeGreaterThan(0);

    const seen = logged("expand.unparseable").length;
    await pollUntil(() => false, ACK_WAIT_TEST_MS + 3_000);
    expect(logged("expand.unparseable").length).toBe(seen);
  }, 60_000);
  it("invariant 10: a FAILED delivery is retried — the same row, a second attempt", async () => {
    // THE REGRESSION TEST FOR THE BUG THIS SUITE DID NOT HAVE.
    //
    // Every other case here uses a fresh delivery, so nothing ever published the
    // SAME delivery to the broker twice — and the relay's deduplication key was
    // the delivery id, which is stable across all seven attempts. JetStream
    // collapsed every retry into the first attempt's message, the publish
    // reported success, and the delivery sat `pending` with a `dispatched_at`
    // that only an outcome report clears. Failing endpoints were never retried
    // at all, and the entire schedule in FR-WHK-03 was unreachable.
    //
    // A walk against `--mode=fail` found it. This is that walk, made to run in CI.
    endpoint.answerWith(500);
    const seeded = await seed(["message.created"]);
    const repo = new seeder.Repository(db, seeded.environmentId);

    const eventId = randomUUID();
    await seeder.expandEventToDeliveries(db, {
      eventId,
      environmentId: seeded.environmentId,
      type: "message.created",
      payload: { id: eventId, type: "message.created" },
    });

    const before = endpoint.received.length;
    await publishDue();
    await pollUntil(() => endpoint.received.length > before);

    const [afterFirst] = await repo.listDeliveriesForEvent(eventId);
    expect(afterFirst!.attempt).toBe(2); // rescheduled, not abandoned
    expect(afterFirst!.state).toBe("pending");

    // The second tier is one second away, so this waits it out rather than
    // rewriting the clock — the schedule under test is the real one.
    await new Promise((resolve) => setTimeout(resolve, retryTiersMs[1]! + 300));

    const beforeSecond = endpoint.received.length;
    await publishDue();
    await pollUntil(() => endpoint.received.length > beforeSecond);

    // The customer was contacted a SECOND time about the same delivery. Without
    // the attempt in the deduplication key this is where it stops forever.
    expect(endpoint.received.length).toBeGreaterThan(beforeSecond);
    const [afterSecond] = await repo.listDeliveriesForEvent(eventId);
    expect(afterSecond!.attempt).toBe(3);
  }, 60_000);
  it("a delivery for a REMOVED endpoint is skipped, not delivered", async () => {
    // The spec's edge case: events already in the retry schedule for an endpoint
    // the customer removed must not be delivered, and must not accumulate.
    //
    // Covered deliberately because it was covered ACCIDENTALLY before — by
    // leftover deliveries other suites had left pointing at endpoints they had
    // deleted. That made `deliver.ts`'s coverage a function of which suites ran
    // first, and a ratchet pinned on it moved on its own.
    endpoint.answerWith(200);
    const seeded = await seed(["message.created"]);
    const repo = new seeder.Repository(db, seeded.environmentId);

    const eventId = randomUUID();
    await seeder.expandEventToDeliveries(db, {
      eventId,
      environmentId: seeded.environmentId,
      type: "message.created",
      payload: { id: eventId, type: "message.created" },
    });

    // Removed AFTER the delivery was scheduled — the whole point. Soft-deleted,
    // so the row is still joinable and the check has to be explicit.
    await repo.deleteEndpoint(seeded.endpointId);

    const before = endpoint.received.length;
    await publishDue();
    await pollUntil(() =>
      logged("delivery.skipped").some((l) => l["reason"] === "endpoint_unavailable"),
    );

    expect(
      logged("delivery.skipped").some((l) => l["reason"] === "endpoint_unavailable"),
    ).toBe(true);
    // And nothing was posted to the customer who asked to stop hearing from us.
    expect(endpoint.received.length).toBe(before);
  }, 60_000);
  it("invariants 4 and 5: the signature ON THE WIRE verifies, over the bytes as sent", async () => {
    // The unit tests prove `signDelivery` is correct. They cannot prove that
    // `deliverOnce` calls it over the RIGHT BYTES and puts the result on the
    // wire — and that gap is exactly where the re-serialisation trap lives, so
    // the one mutation the sabotage list aims at it would have passed.
    //
    // Verified here the way a customer verifies: `node:crypto`, the documented
    // recipe, and the raw body as received. Nothing from the signing path.
    endpoint.answerWith(200);
    const seeded = await seed(["message.created"]);
    const { eventId } = await deliverEvent(seeded, "message.created");

    const request = endpoint.received.find((r) => r.body.includes(eventId));
    expect(request).toBeDefined();

    const timestamp = request!.headers["relay-webhook-timestamp"];
    const offered = String(request!.headers["relay-webhook-signature"])
      .split(",")
      .map((part) => part.trim().replace(/^v1=/, ""));

    // The RAW body, byte for byte as it arrived. Parsing it and re-serialising
    // would be the customer making the same mistake the platform must not.
    const expected = createHmac("sha256", seeded.secret)
      .update(`v1:${timestamp}:${request!.body}`)
      .digest("hex");

    expect(offered).toContain(expected);
  }, 60_000);
});
