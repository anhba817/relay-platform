// Chapter 2.7's walk: Tuan drives into the tunnel and comes back out.
//
// Phase 1 is the resume itself — connect, hear a message, lose the socket
// mid-conversation, miss two more, reconnect with the cursor, and see exactly
// what was missed and nothing else.
//
// Phase 2 is FR-RTM-04's ceiling: a channel that ran away while the client
// was gone, where the honest answer is "page history instead."
//
//   node services/api/dist/main.js &
//   (cd services/gateway && PORT=4001 pnpm exec tsx src/main.ts &)
//   node scripts/tunnel-walk.mjs
import { SignJWT } from "jose";
import WebSocket from "ws";

import { createDb, createPool } from "../services/api/dist/db/client.js";
import {
  createEnvironment,
  Repository,
} from "../services/api/dist/db/repository.js";

const GW = process.env.RELAY_GW ?? "ws://127.0.0.1:4001";
const SECRET = process.env.RELAY_DEV_JWT_SECRET ?? "dev-secret";
const BACKFILL_LIMIT = 500;

const db = createDb(createPool());
const env = await createEnvironment(db, { name: `tunnel-${Date.now()}` });
const repo = new Repository(db, env.id);
const tuan = await repo.createUser("tuan", "Tuan");
const dispatcher = await repo.createUser("dispatcher", "Dispatcher");
const channel = await repo.createChannel("fleet", "public");
const flood = await repo.createChannel("flood", "public");
for (const c of [channel, flood]) {
  await repo.addMember(c.id, tuan.id);
  await repo.addMember(c.id, dispatcher.id);
}

const token = (sub) =>
  new SignJWT({ env: env.id })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .sign(new TextEncoder().encode(SECRET));

/** Connect and report every frame, keeping a cursor the way a client would:
 * the highest sequence it has actually applied, per channel. */
async function connect(label, sub, cursors = {}, quiet = false) {
  const query = Object.entries(cursors)
    .map(([id, seq]) => `&cursor=${id}:${seq}`)
    .join("");
  const socket = new WebSocket(`${GW}/v1/ws?token=${await token(sub)}${query}`);
  const applied = { ...cursors };
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "connection.ack") {
      console.log(
        `  ${label} ← connection.ack resume_ok=${frame.payload.resume_ok} truncated=${JSON.stringify(frame.payload.truncated)}`,
      );
      return;
    }
    if (frame.type === "message.created") {
      const { channel: id, seq, text } = frame.payload;
      applied[id] = Math.max(applied[id] ?? 0, seq);
      const where = id === channel.id ? "fleet" : "flood";
      if (!quiet) {
        console.log(
          `  ${label} ← message.created ${where} seq=${seq} "${text}"`,
        );
      }
      return;
    }
    console.log(`  ${label} ← ${JSON.stringify(frame)}`);
  });
  await new Promise((resolve) => socket.on("open", resolve));
  return { socket, applied };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("phase 1 — into the tunnel\n");
// The dispatcher sends through a SOCKET, not straight into the database.
// Writing through the repository would commit the row and publish nothing —
// the REST-send asymmetry 2.6 left open — and Tuan would never hear anything
// live, which would quietly turn this walk into a lie.
const dispatch = await connect("dispatcher", "dispatcher", {}, true);
const say = (text) =>
  dispatch.socket.send(
    JSON.stringify({
      type: "message.send",
      payload: { idem_key: `k-${text}`, channel: channel.id, text },
    }),
  );

const first = await connect("tuan", "tuan");
await wait(300);
say("convoy leaving in five");
await wait(400);

// The tunnel: no close frame, no goodbye — the radio simply stops.
first.socket.terminate();
console.log(
  `\n  …signal lost (cursor at fleet:${first.applied[channel.id] ?? 0})`,
);
say("which entrance?");
say("B2, north ramp");
await wait(500);
console.log("  two messages sent while Tuan is underground\n");

console.log("phase 1 — out the other side, resuming from the cursor");
const back = await connect("tuan", "tuan", {
  [channel.id]: first.applied[channel.id] ?? 0,
});
await wait(600);
console.log(
  `\n  applied through fleet:${back.applied[channel.id]} — and seq 1, heard live before the tunnel, was NOT resent\n`,
);
back.socket.terminate();
dispatch.socket.terminate();

console.log(
  `phase 2 — a channel that ran away (${BACKFILL_LIMIT + 1} messages)`,
);
for (let i = 1; i <= BACKFILL_LIMIT + 1; i++) {
  await repo.sendMessage(flood.id, { text: `m${i}`, userId: dispatcher.id });
}
let delivered = 0;
const listener = await connect("tuan", "tuan", { [flood.id]: 0 }, true);
listener.socket.on("message", (raw) => {
  if (JSON.parse(raw.toString()).type === "message.created") delivered++;
});
await wait(1500);
console.log(
  `\n  frames delivered on resume: ${delivered} of ${BACKFILL_LIMIT + 1} — the rest is history's job (FR-RTM-04)`,
);
listener.socket.terminate();
process.exit(0);
