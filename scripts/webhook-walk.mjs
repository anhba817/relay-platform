// The chapter 3.5 walk: one event, all the way to a customer's server.
//
//   # in one terminal
//   node scripts/hostile-endpoint.mjs --mode=ok
//
//   # in another
//   node scripts/webhook-walk.mjs
//   node scripts/webhook-walk.mjs --print-signing-material
//   node scripts/webhook-walk.mjs --fast-forward     # against --mode=fail
//   node scripts/webhook-walk.mjs --send-only        # leave it for the real dispatcher
//   node scripts/webhook-walk.mjs --fast-forward --watch-disable   # chapter 3.6
//
//   --url=http://127.0.0.1:4555/hook   where to point the endpoint
//   --api-port=4141                    the api this walk spawns for itself
//   --watch-disable                    chapter 3.6: print the failure run as it
//                                      grows and the disablement when it lands.
//                                      Ages the run rather than waiting an hour.
//   --secret=SECRET                    pin the signing secret instead of minting
//                                      one, so the endpoint can be started with
//                                      the same value and verify what arrives:
//
//     node scripts/hostile-endpoint.mjs --secret=hunter2
//     node scripts/webhook-walk.mjs     --secret=hunter2 --print-signing-material
//
// WHAT THIS SHOWS, in order: an endpoint is registered with a signing secret the
// platform stores encrypted; an event is expanded into one delivery row per
// matching endpoint INSIDE the claim transaction, so a redelivered event cannot
// double a customer's webhooks; the api's relay publishes what is due; the
// dispatcher posts it, signed, and reports the outcome back over the internal
// seam — because constitution IV does not let it touch PostgreSQL itself.
//
// The walk SPAWNS ITS OWN API. The dispatcher reaches state over HTTP and there
// has to be something at the other end, and a walk that told the reader to start
// three services first would be a walk nobody runs. Its stores are the compose
// ones; nothing else is assumed.
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const API_DIST = join(ROOT, "services", "api", "dist");

const { createDb, createPool } = await import(join(API_DIST, "db", "client.js"));
const { createEnvironment, Repository, expandEventToDeliveries, deliveryMaterial } =
  await import(join(API_DIST, "db", "repository.js"));
const { encryptSecret, mintSigningSecret } = await import(
  join(API_DIST, "webhooks", "secret.js")
);
const { createDeliveryRelay, ensureDeliveriesStream } = await import(
  join(API_DIST, "webhooks", "delivery-relay.js")
);
const { createJetStreamPublisher } = await import(
  join(API_DIST, "outbox", "jetstream.publisher.js")
);
const { createLogger } = await import(
  join(ROOT, "packages", "service-kit", "dist", "index.js")
);
const { createDispatcher } = await import(
  join(ROOT, "services", "dispatcher", "dist", "main.js")
);
const { SIGNATURE_SCHEME } = await import(
  join(ROOT, "services", "dispatcher", "dist", "signature.js")
);
const { DISABLE_AFTER_MS, DISABLE_MIN_ATTEMPTS } = await import(
  join(API_DIST, "webhooks", "disable.js")
);
const { RETRY_TIERS_MS, MAX_ATTEMPTS } = await import(
  join(API_DIST, "webhooks", "schedule.js")
);
const { DeliverPolicy } = await import(
  join(ROOT, "services", "dispatcher", "node_modules", "nats", "lib", "src", "mod.js")
);

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const ENDPOINT_URL = arg("url", "http://127.0.0.1:4555/hook");
const API_PORT = Number(arg("api-port", "4141"));
const PRINT_MATERIAL = flag("print-signing-material");
const SEND_ONLY = flag("send-only");
const FAST_FORWARD = flag("fast-forward");
const WATCH_DISABLE = flag("watch-disable");
const PINNED_SECRET = arg("secret", "");
const CREDENTIAL = "rk_svc_walk_0123456789abcdef0123456789abcd";

const show = (label, value) => console.log(`${label.padEnd(26)} ${value}`);
const rule = (title) => console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 46 - title.length))}`);

const pool = createPool();
const db = createDb(pool);

// ---------------------------------------------------------------------------
// SETUP, before the narrative starts, and the order is not cosmetic.
//
// The dispatcher's consumers are created HERE — before anything is published —
// because they start at `New`. A durable name is a POSITION in a stream, and a
// consumer created afterwards would begin after the message this walk is about
// and wait forever for something it had already missed. (Starting at `All`
// instead is worse in a different way: the walk replays every event the stream
// has ever held, which on a development machine is every test run since 3.3.)
rule("0. the api and the dispatcher this walk drives");

const api = spawn("node", [join(API_DIST, "main.js")], {
  env: {
    ...process.env,
    PORT: String(API_PORT),
    RELAY_INTERNAL_CREDENTIAL: CREDENTIAL,
    // This walk drives both loops by hand, so the background copies would race it.
    RELAY_OUTBOX_RELAY: "off",
    RELAY_EVENT_CONSUMER: "off",
    RELAY_DELIVERY_RELAY: "off",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

const stop = async () => {
  api.kill();
  await pool.end().catch(() => {});
};

const deadline = Date.now() + 30_000;
for (;;) {
  try {
    if ((await fetch(`http://127.0.0.1:${API_PORT}/healthz`)).ok) break;
  } catch {
    // not up yet
  }
  if (Date.now() > deadline) {
    console.error("the api never became healthy");
    await stop();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 100));
}
show("api", `http://127.0.0.1:${API_PORT}  (spawned by this walk)`);

const dispatcher = createDispatcher({
  apiUrl: `http://127.0.0.1:${API_PORT}`,
  credential: CREDENTIAL,
  durables: {
    expand: `walk-expand-${randomUUID().slice(0, 8)}`,
    deliver: `walk-deliver-${randomUUID().slice(0, 8)}`,
  },
  deliverPolicy: DeliverPolicy.New,
  // Short, because the relay below is GLOBAL: it publishes every delivery in the
  // database that is due, including rows an old test run left pointing at
  // `example.test`. Those are not this walk's business and must not cost it ten
  // seconds each on the way past.
  attemptTimeoutMs: 3_000,
  logger: createLogger("walk-dispatcher"),
});
await dispatcher.ready();
show("dispatcher", "consumers created, positioned at NEW");

// ---------------------------------------------------------------------------
rule("1. an endpoint, with a secret the platform encrypts");

const env = await createEnvironment(db, { name: `webhook-walk-${randomUUID().slice(0, 8)}` });
const repo = new Repository(db, env.id);

// Minted here so the walk can PRINT it. In the platform this value exists in
// plaintext exactly twice: once when it is shown to the customer at creation,
// and once inside the dispatcher for as long as it takes to sign. What is
// stored is the ciphertext.
const secret = PINNED_SECRET || mintSigningSecret();
const endpoint = await repo.createEndpoint({
  url: ENDPOINT_URL,
  eventTypes: ["message.created"],
  secretCiphertext: encryptSecret(secret),
});

show("environment", env.id);
show("endpoint", endpoint.id);
show("url", ENDPOINT_URL);
show("secret (shown once)", `${secret}${PINNED_SECRET ? "   (pinned by --secret)" : ""}`);
show("stored as", `${encryptSecret(secret).slice(0, 32)}…  (iv|tag|ciphertext, AES-256-GCM)`);

// ---------------------------------------------------------------------------
rule("2. one event becomes one delivery per matching endpoint");

const eventId = randomUUID();
const payload = {
  id: eventId,
  type: "message.created",
  environment_id: env.id,
  occurred_at: new Date().toISOString(),
  data: { id: randomUUID(), seq: 1, user: "tuan", text: "B2, north ramp" },
};

const expansion = await expandEventToDeliveries(db, {
  eventId,
  environmentId: env.id,
  type: "message.created",
  payload,
});
show("event", eventId);
show("delivery rows created", expansion.created);

// The same event again. Not a demonstration of a bug — a demonstration that the
// claim transaction absorbs it, which is the whole reason expansion writes rows
// instead of publishing N messages.
const again = await expandEventToDeliveries(db, {
  eventId,
  environmentId: env.id,
  type: "message.created",
  payload,
});
show("expanded a second time", `created=${again.created} duplicate=${again.duplicate}`);

// ---------------------------------------------------------------------------
if (PRINT_MATERIAL) {
  rule("the signing recipe, in full");

  // THE BYTES THAT ACTUALLY GO OUT, fetched the way the dispatcher fetches them.
  //
  // This block used to sign `payload` — the object this script built a few lines
  // above — and it was WRONG in a way that took a run against a real endpoint to
  // see. The payload is stored as `jsonb`, and PostgreSQL does not preserve key
  // order, so what comes back out is the same object and a different rendering.
  // A reader following this recipe computed a signature over one ordering while
  // the platform had signed another, and the mismatch would have looked like a
  // bug in the platform rather than in the walk.
  //
  // That is the re-serialisation trap, aimed at ourselves, from the one direction
  // that catches everybody: nobody re-serialised anything on purpose. The
  // database did it in the round trip.
  const [row] = await repo.listDeliveriesForEvent(eventId);
  const material = await deliveryMaterial(db, row.id);

  const rawBody = JSON.stringify(material.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const canonical = `${SIGNATURE_SCHEME}:${timestamp}:${rawBody}`;
  const signature = createHmac("sha256", material.secrets[0]).update(canonical).digest("hex");

  console.log("\n  canonical string = v1:{timestamp}:{raw body}");
  console.log("  signature        = hex(HMAC-SHA256(secret, canonical string))\n");
  show("  secret", material.secrets[0]);
  show("  timestamp", timestamp);
  show("  raw body", rawBody);
  show("  canonical", canonical);
  show("  signature", signature);

  // The point of V5. If this can only be verified with the platform's own code,
  // it is not a contract — so here it is with a tool that knows nothing about us.
  console.log("\n  verify it without any of our code:\n");
  console.log(
    `    printf '%s' ${JSON.stringify(canonical)} | openssl dgst -sha256 -hmac ${JSON.stringify(material.secrets[0])}\n`,
  );
  console.log("  The TIMESTAMP above is this moment, not the one the live attempt used —");
  console.log("  every attempt re-signs, which is what stops a captured request being");
  console.log("  replayed forever. To check a real one, run the endpoint with");
  console.log(`  --secret=${material.secrets[0]} and it verifies each arrival itself.\n`);
  console.log("  Then re-serialise the body — reorder a key, add a space — and watch it");
  console.log("  fail. That failure is the reason the raw bytes are signed, not the object.\n");
}

// ---------------------------------------------------------------------------
rule("3. the api's relay publishes what is DUE");

const relay = createDeliveryRelay({
  db,
  publisher: createJetStreamPublisher({ ensure: ensureDeliveriesStream }),
  logger: createLogger("walk-relay"),
});
// GLOBAL by design — the relay drains what is due across the platform, not what
// this walk happens to have created. A number larger than one is other rows
// falling due, which is worth seeing rather than hiding.
show("published to the stream", await relay.drainOnce());

if (SEND_ONLY) {
  // V6: the rows exist and are due, and this process is walking away without
  // delivering them. Start the dispatcher and it drains them with nobody
  // intervening — which is the demonstration that the split bought something.
  console.log("\n--send-only: the deliveries are due and nothing has posted them.");
  console.log("start the dispatcher and it drains the backlog on its own.\n");
  await pool.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
rule("4. the dispatcher posts it, and reports back over the seam");

const report = async () => {
  const rows = await repo.listDeliveriesForEvent(eventId);
  for (const row of rows) {
    show(
      `  delivery ${row.id.slice(0, 8)}`,
      `attempt=${row.attempt} state=${row.state} next=${row.next_attempt_at}`,
    );
  }
  return rows;
};

await dispatcher.pollOnce();
console.log("");
await report();

/** The endpoint's failure run, straight from the row auto-disable reads.
 *
 * Read with plain SQL because this script is a reader's tool and the columns are
 * the point: `enabled` is what stops deliveries, and `disabled_at` is how a
 * customer tells a platform disablement from their own (FR-009). */
const runOf = async () => {
  const { rows } = await pool.query(
    `SELECT enabled, disabled_at, disabled_reason,
            failure_run_started_at, failure_run_attempts
       FROM webhook_endpoints WHERE id = $1`,
    [endpoint.id],
  );
  return rows[0];
};

// ---------------------------------------------------------------------------
if (FAST_FORWARD) {
  rule("5. the whole schedule, without waiting for it");

  console.log(
    `  tiers: ${RETRY_TIERS_MS.map((ms) => (ms === 0 ? "now" : `${ms / 1000}s`)).join(" → ")}`,
  );
  console.log(`  ${MAX_ATTEMPTS} attempts, then the delivery is dead-lettered.\n`);
  console.log("  the waits are REAL in production. This rewrites next_attempt_at so a");
  console.log("  reader can watch the end of the schedule without waiting two hours —");
  console.log("  it is a fast-forward through the clock, not a shortcut around the logic.\n");

  /** POLL, don't peek. `drainOnce` publishes and returns; the message reaches the
   * consumer a moment later, so a single `pollOnce` after it is a race — one
   * that passes on a quiet machine and stalls on a busy one. The integration
   * suite learned this three times; the walk gets it for free by copying. */
  const pollUntil = async (done, timeoutMs = 15_000) => {
    const until = Date.now() + timeoutMs;
    while (!(await done()) && Date.now() < until) await dispatcher.pollOnce();
  };

  const stateOf = async () => (await repo.listDeliveriesForEvent(eventId))[0];


  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    const before = await stateOf();
    if (!before || before.state !== "pending") break;

    // Drag everything still pending into the past, then run the two loops the
    // way they run in production.
    await pool.query(
      `UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'
        WHERE event_id = $1 AND state = 'pending'`,
      [eventId],
    );
    await relay.drainOnce();

    // Wait for THIS delivery to move — a new attempt number, or out of pending
    // altogether. Counting published messages would not do: the relay is global,
    // so the number it returns is mostly other people's work.
    await pollUntil(async () => {
      const now_ = await stateOf();
      return !now_ || now_.state !== "pending" || now_.attempt !== before.attempt;
    });

    const after = await stateOf();
    show(
      `  attempt ${before.attempt}`,
      after && after.attempt !== before.attempt
        ? `failed → rescheduled as attempt ${after.attempt}`
        : `failed → ${after ? after.state : "gone"}`,
    );

    if (WATCH_DISABLE) {
      const run = await runOf();
      show(
        "    endpoint",
        run.failure_run_started_at
          ? `run open · ${run.failure_run_attempts} failures · enabled=${run.enabled}`
          : `no run · enabled=${run.enabled}`,
      );
    }
  }

  console.log("");
  await report();

  const dead = (await repo.listDeadLetters()).filter((d) => d.event_id === eventId);
  console.log("");
  show("dead letters", dead.length);
  for (const d of dead) {
    show(`  ${d.id.slice(0, 8)}`, `attempts=${d.attempts} last_status=${d.last_status ?? "none"}`);
  }
}

// ---------------------------------------------------------------------------
if (WATCH_DISABLE) {
  rule("6. when to stop trying");

  console.log("  The run above is what auto-disable reads — two columns on the endpoint,");
  console.log("  never the attempt stream. A backlogged analytics path cannot delay a");
  console.log("  disablement, and a broker being unwell cannot block one.\n");
  console.log(`  The rule: longer than ${DISABLE_AFTER_MS / 60000} minutes AND at least`);
  console.log(`  ${DISABLE_MIN_ATTEMPTS} failures. Both, never either — the hour alone would let one`);
  console.log("  failure followed by a two-hour retry gap disable an endpoint.\n");

  const before = await runOf();
  show("failures in the run", before.failure_run_attempts ?? 0);
  show("enabled", before.enabled);

  if (!before.failure_run_started_at) {
    console.log("\n  No open run — the endpoint answered 2xx at some point, which CLEARS it.");
    console.log("  Point this at --mode=fail to watch a run survive long enough to matter.\n");
  } else {
    // AGED, not waited out. Same honesty as --fast-forward above: the clock moves,
    // the logic does not. An hour and four minutes of real time would make this
    // demonstration one nobody runs.
    console.log("  aging the run past the hour (the clock moves, the rule does not)...\n");
    await pool.query(
      `UPDATE webhook_endpoints
          SET failure_run_started_at = now() - interval '64 minutes'
        WHERE id = $1`,
      [endpoint.id],
    );

    // THE SWEEP, which is the trigger this endpoint needs. Its last attempt has
    // already been made — the delivery dead-lettered above — so no further outcome
    // will ever be reported and an on-outcome check would never fire again. That is
    // research R1's quiet endpoint, and it is the reason there are two triggers.
    const disabled = await relay.sweepOnce();
    show("endpoints the sweep disabled", disabled);

    const after = await runOf();
    console.log("");
    show("enabled", after.enabled);
    show("disabled_at", after.disabled_at ? after.disabled_at.toISOString() : "null");
    show("disabled_reason", after.disabled_reason ?? "null");

    const { rows: notes } = await pool.query(
      `SELECT run_attempts, last_status, last_error, delivered_at
         FROM webhook_disable_notifications WHERE endpoint_id = $1`,
      [endpoint.id],
    );
    console.log("");
    show("notification rows", notes.length);
    for (const n of notes) {
      show(
        `  run of ${n.run_attempts}`,
        `last_status=${n.last_status ?? "none"} delivered_at=${n.delivered_at ?? "null"}`,
      );
    }
    console.log("");
    console.log("  `delivered_at` is null and stays null. FR-WHK-07 asks for the");
    console.log("  organisation to be notified BY EMAIL, and this platform has no email");
    console.log("  transport of any kind. The row is the obligation; the null is the");
    console.log("  admission. Chapter 3.7 needs the same transport for quotas.\n");

    // Running it again must change nothing. At most once per run, enforced by the
    // `enabled = true` predicate in the update rather than by a check.
    const second = await relay.sweepOnce();
    show("a second sweep disables", second);
  }
}

rule("what to take from this");
console.log(`
  The delivery row is the schedule. Not a message the broker is holding — that
  was measured in research R1 and rejected, because a sleeping message keeps its
  acknowledgement slot and dead endpoints would starve healthy ones.

  The dispatcher never wrote to PostgreSQL. Every state change above went through
  the api over HTTP, because constitution IV reserves those writes to one service
  and a second one would make "who owns this row" a question again.

  And the last hop is at-least-once, deliberately. The dispatcher posts, THEN
  reports; a crash in that gap re-posts. The customer absorbs it on the event id
  they were handed, which is a duplicate they can see rather than a loss nobody
  can.
`);

await dispatcher.stop();
await stop();
// Explicit, as in every other walk in this directory: the spawned api is a live
// child handle and the pool holds sockets, so a script that merely stops doing
// work looks to a reader exactly like a script that hung.
process.exit(0);
