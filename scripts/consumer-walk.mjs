// The chapter 3.4 walk: a redelivery, made to happen on purpose.
//
//   node scripts/consumer-walk.mjs                     # consume normally
//   node scripts/consumer-walk.mjs --kill-before-ack   # die in the gap
//   node scripts/consumer-walk.mjs --resume=walk-1234  # pick the corpse back up
//   node scripts/consumer-walk.mjs --from=all --limit=50
//
// The interesting pair is the middle two, run in that order. The kill mode does
// by hand what the runtime does in a loop — fetch, claim (which commits the
// effect), acknowledge — and prints `MARKER kill-me-now` between the commit and
// the acknowledgement, where it dies. A parent watching stdout can SIGKILL it
// there (the integration suite does); left alone it SIGKILLs itself, so the
// demonstration is one command.
//
// Then `--resume` reuses that durable name — which is a POSITION, not a label —
// and receives the same event again, because the broker never heard an
// acknowledgement. The ledger recognises it, and the effect does not happen
// twice. That is the chapter.
import { randomUUID } from "node:crypto";

import { connect, AckPolicy } from "../services/api/node_modules/nats/lib/src/mod.js";
import { subjectFor } from "../packages/protocol/dist/index.js";
import { createDb, createPool } from "../services/api/dist/db/client.js";
import { claimEvent, timesHandled } from "../services/api/dist/db/repository.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const URL_ = process.env.RELAY_NATS_URL ?? "nats://127.0.0.1:4222";
const LIMIT = Number(arg("limit", "5"));
const PAUSE_MS = Number(arg("pause", "400"));
const KILL_MODE = flag("kill-before-ack");
const FROM_ALL = arg("from", "new") === "all";
const RESUME = arg("resume", "");

const show = (label, value) => console.log(`${label.padEnd(26)} ${value}`);

const db = createDb(createPool());
const nc = await connect({ servers: URL_ });
const jsm = await nc.jetstreamManager();
const js = nc.jetstream();

// A durable per run: a durable name is a POSITION, and reusing one would make
// this walk inherit the last run's progress. Which is precisely what --resume
// wants, so it says the name out loud instead.
const durable = RESUME || `walk-${randomUUID().slice(0, 8)}`;
const environmentId = randomUUID();

if (!RESUME) {
  await jsm.consumers.add("EVENTS", {
    durable_name: durable,
    ack_policy: AckPolicy.Explicit,
    ack_wait: 30 * 1e9,
    max_deliver: 5,
    filter_subject: FROM_ALL ? "events.>" : subjectFor("message.created", environmentId),
  });
}
show("durable consumer", durable);
if (!RESUME) show("environment", environmentId);

if (!FROM_ALL && !RESUME) {
  // Publish one event for this walk to find, the way the relay would.
  const id = randomUUID();
  await js.publish(
    subjectFor("message.created", environmentId),
    new TextEncoder().encode(
      JSON.stringify({
        id,
        type: "message.created",
        environment_id: environmentId,
        occurred_at: new Date().toISOString(),
        data: {
          id: randomUUID(),
          channel_id: randomUUID(),
          seq: 1,
          user: "tuan",
          text: "B2, north ramp",
          created_at: new Date().toISOString(),
        },
      }),
    ),
    { msgID: id },
  );
  show("published", id);
}

const consumer = await js.consumers.get("EVENTS", durable);

/** One fetch, unless we are waiting for a redelivery — which cannot arrive
 * before `ack_wait` has elapsed on the delivery nobody acknowledged. Thirty
 * seconds of nothing happening is the guarantee working, not a hang. */
async function nextBatch() {
  const deadline = Date.now() + (RESUME ? 45_000 : 0);
  let announced = false;
  for (;;) {
    const batch = await consumer.fetch({ max_messages: LIMIT, expires: 2_000 });
    const messages = [];
    for await (const message of batch) messages.push(message);
    if (messages.length > 0 || Date.now() >= deadline) return messages;
    if (!announced) {
      announced = true;
      show("waiting", "nothing yet — the broker redelivers after ack_wait (30s)");
    }
  }
}

let handled = 0;
for (const message of await nextBatch()) {
  const event = JSON.parse(new TextDecoder().decode(message.data));
  show("delivered", `${event.id} attempt=${message.info.deliveryCount} redelivered=${message.redelivered}`);

  // The claim and the effect commit together (chapter 3.4). After this line the
  // work has HAPPENED, durably, and the broker still believes it has not.
  const result = await claimEvent(db, durable, event.id, async () => {});
  show("claim", result);
  handled += result === "handled" ? 1 : 0;

  if (KILL_MODE) {
    show("times handled", await timesHandled(db, durable, event.id));
    console.log("MARKER kill-me-now");
    // The window a parent uses to kill this process from outside — which is what
    // the integration suite does, watching stdout for the marker.
    await new Promise((r) => setTimeout(r, PAUSE_MS));
    // Nobody killed it, so it kills itself. SIGKILL to its own pid is a real
    // uncatchable death, not a tidy `process.exit()`: no flush, no `finally`,
    // no drain. The work above HAPPENED and was never acknowledged, which is
    // exactly the state a redelivery is for. Run by hand, this is the whole
    // demonstration in one command.
    process.kill(process.pid, "SIGKILL");
  }

  if (RESUME) show("times handled", await timesHandled(db, durable, event.id));

  message.ack();
  show("acknowledged", event.id);
}

if (FROM_ALL) show("handled in this batch", handled);
await nc.drain();
process.exit(0);
