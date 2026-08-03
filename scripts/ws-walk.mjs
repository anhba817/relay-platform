// The chapter 2.5 walk, as a script (so the transcript in the chapter is
// reproducible rather than decorative). Seeds a user, channel and
// membership, mints a dev token, connects, sends, and retries with the
// SAME idempotency key so 2.3's recovery leg shows through the socket.
import { SignJWT } from "jose";
import WebSocket from "ws";

import { createDb, createPool } from "../services/api/dist/db/client.js";
import {
  createEnvironment,
  Repository,
} from "../services/api/dist/db/repository.js";

const GATEWAY = process.env.RELAY_GATEWAY_URL ?? "ws://127.0.0.1:4001";
const SECRET = process.env.RELAY_DEV_JWT_SECRET ?? "dev-secret";

const db = createDb(createPool());
const env = await createEnvironment(db, { name: `ws-walk-${Date.now()}` });
const repo = new Repository(db, env.id);
const user = await repo.createUser("tuan", "Tuan");
const channel = await repo.createChannel("fleet", "public");
await repo.addMember(channel.id, user.id);

const token = await new SignJWT({ env: env.id })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject("tuan")
  .sign(new TextEncoder().encode(SECRET));

const started = Date.now();
const socket = new WebSocket(`${GATEWAY}/v1/ws?token=${token}`);
const frame = {
  type: "message.send",
  payload: {
    idem_key: "walk-key-1",
    channel: channel.id,
    text: "B2, north ramp",
  },
};

socket.on("message", (raw) => {
  const received = JSON.parse(raw.toString());
  console.log(`← ${Date.now() - started}ms  ${JSON.stringify(received)}`);
  if (received.type === "connection.ack") {
    console.log(`→       ${JSON.stringify(frame)}`);
    socket.send(JSON.stringify(frame));
    setTimeout(() => {
      console.log("→       retry, SAME key");
      socket.send(JSON.stringify(frame));
    }, 250);
  }
});
setTimeout(() => process.exit(0), 1500);
