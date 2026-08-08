// The chapter 2.5 walk, as a script (so the transcript in the chapter is
// reproducible rather than decorative). Seeds a user, channel and
// membership, mints a dev token, connects, sends, and retries with the
// SAME idempotency key so 2.3's recovery leg shows through the socket.
import WebSocket from "ws";

import { createDb, createPool } from "../services/api/dist/db/client.js";
import {
  createApiKey,
  createEnvironment,
  Repository,
} from "../services/api/dist/db/repository.js";

const GATEWAY = process.env.RELAY_GATEWAY_URL ?? "ws://127.0.0.1:4001";

const db = createDb(createPool());
const env = await createEnvironment(db, { name: `ws-walk-${Date.now()}` });
const repo = new Repository(db, env.id);
const user = await repo.createUser("tuan", "Tuan");
const channel = await repo.createChannel("fleet", "public");
await repo.addMember(channel.id, user.id);

const API = process.env.RELAY_API_URL ?? "http://127.0.0.1:4000";
// Chapter 3.2: nothing outside the api can sign a token, so this walk gets one
// the way a reader does — mint the environment's key, then ask the
// development-only endpoint for a token (FR-AUT-09).
const key = await createApiKey(db, { environmentId: env.id });
const token = async (sub) => {
  const res = await fetch(`${API}/auth/dev-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key.credential}`,
    },
    body: JSON.stringify({ user: sub }),
  });
  if (!res.ok) throw new Error(`dev-token failed: ${res.status}`);
  return (await res.json()).token;
};

const tuanToken = await token("tuan");

const started = Date.now();
const socket = new WebSocket(`${GATEWAY}/v1/ws?token=${tuanToken}`);
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
