// The chapter 3.3 walk: the dual-write problem, and the fix, run side by side.
//
//   node scripts/dual-write-walk.mjs --mode=naive
//   node scripts/dual-write-walk.mjs --mode=outbox
//   node scripts/dual-write-walk.mjs --mode=outbox --messages=200
//
// Both modes write a message and then publish an event. They differ in ONE
// respect — when the event becomes durable — and that difference is the whole
// chapter.
//
// The script prints `MARKER kill-me-now` between the commit and the publish and
// then waits, so a parent process can `SIGKILL` it exactly in the gap. That is
// how outbox.itest.ts turns "the process died at the worst moment" into a
// repeatable test rather than a story. Run by hand with nobody killing it, the
// script simply carries on and reports what happened.
//
// DECISION (chapter 3.3): the naive publish-after-commit path lives HERE and in
// no service. It is a teaching artifact, like split-brain.mjs — fenced, so it
// cannot quietly stop compiling, and outside services/ so that nobody copying
// the repository ships the bug (research R5).
import { createDb, createPool } from "../services/api/dist/db/client.js";
import {
  createEnvironment,
  Repository,
  drainOutbox,
} from "../services/api/dist/db/repository.js";
import { messageCreatedEvent } from "../services/api/dist/outbox/event.js";
import { createJetStreamPublisher } from "../services/api/dist/outbox/jetstream.publisher.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const MODE = arg("mode", "outbox");
const COUNT = Number(arg("messages", "1"));
const PAUSE_MS = Number(arg("pause", "400"));

if (MODE !== "naive" && MODE !== "outbox") {
  console.error(`unknown --mode=${MODE} (expected naive or outbox)`);
  process.exit(2);
}

const db = createDb(createPool());
const env = await createEnvironment(db, { name: `dual-write-${Date.now()}` });
const repo = new Repository(db, env.id);
const tuan = await repo.createUser("tuan", "Tuan");
const channel = await repo.createChannel("fleet", "public");
await repo.addMember(channel.id, tuan.id);

const show = (label, value) => console.log(`${label.padEnd(26)} ${value}`);
show("environment", env.id);
show("mode", MODE);

const pending = async () => {
  const rows = await db.execute(
    `SELECT count(*)::int AS n FROM outbox
      WHERE published_at IS NULL AND payload->>'environment_id' = '${env.id}'`,
  );
  return rows.rows[0].n;
};

if (MODE === "naive") {
  // ── the way you would write it first ────────────────────────────────────
  // Commit the message. Then publish the event. Nothing wrong with either
  // step; everything wrong with the gap between them.
  for (let i = 0; i < COUNT; i++) {
    const id = crypto.randomUUID();
    const seq = i + 1;
    await db.execute(
      `INSERT INTO messages (id, channel_id, sequence, user_id, text, metadata)
       VALUES ('${id}', '${channel.id}', ${seq}, '${tuan.id}', 'B2, north ramp', '{}')`,
    );
    await db.execute(
      `UPDATE channels SET last_sequence = ${seq} WHERE id = '${channel.id}'`,
    );
  }
  show("messages committed", COUNT);
  show("outbox rows", await pending());

  console.log("MARKER kill-me-now");
  await new Promise((r) => setTimeout(r, PAUSE_MS));

  // A process that dies above this line has committed messages and owes
  // events that no longer exist anywhere. Nothing errored. Nothing to replay.
  const publisher = createJetStreamPublisher();
  for (let i = 0; i < COUNT; i++) {
    const event = messageCreatedEvent({
      eventId: crypto.randomUUID(),
      environmentId: env.id,
      message: {
        id: crypto.randomUUID(),
        channel_id: channel.id,
        seq: i + 1,
        user: "tuan",
        text: "B2, north ramp",
        created_at: new Date().toISOString(),
      },
    });
    await publisher.publish({
      subject: event.subject,
      id: event.payload.id,
      payload: event.payload,
    });
  }
  await publisher.close();
  show("events published", COUNT);
  show("durable record of them", "none — the publish WAS the record");
} else {
  // ── the way it survives ─────────────────────────────────────────────────
  // The event row commits with the message. The publish is somebody else's
  // problem, later, from a table.
  for (let i = 0; i < COUNT; i++) {
    await repo.sendMessage(channel.id, {
      text: "B2, north ramp",
      userId: tuan.id,
      userExternalId: "tuan",
    });
  }
  show("messages committed", COUNT);
  show("outbox rows waiting", await pending());

  console.log("MARKER kill-me-now");
  await new Promise((r) => setTimeout(r, PAUSE_MS));

  // A process that dies above this line has lost nothing: the rows are in
  // Postgres and the next relay to run will publish them.
  const publisher = createJetStreamPublisher();
  let published = 0;
  for (;;) {
    const moved = await drainOutbox(db, 100, async (row) => {
      await publisher.publish({
        subject: row.subject,
        id: row.payload.id,
        payload: row.payload,
      });
    });
    published += moved;
    if (moved === 0) break;
  }
  await publisher.close();
  show("events published", published);
  show("outbox rows waiting", await pending());
}

process.exit(0);
