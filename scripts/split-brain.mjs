// The chapter 2.6 demonstration: two gateway instances, two users, one
// channel. Run it BEFORE fanout.ts exists (or with Redis stopped) to see
// the conversation split in half, and again after to see it whole. The
// script does not assert which outcome is correct — it REPORTS what the
// far side heard, so the same command tells you the truth in both states.
import WebSocket from "ws";

import { createDb, createPool } from "../services/api/dist/db/client.js";
import {
  createApiKey,
  createEnvironment,
  Repository,
} from "../services/api/dist/db/repository.js";

const G1 = process.env.RELAY_GW1 ?? "ws://127.0.0.1:4001";
const G2 = process.env.RELAY_GW2 ?? "ws://127.0.0.1:4002";

const db = createDb(createPool());
const env = await createEnvironment(db, { name: `split-${Date.now()}` });
const repo = new Repository(db, env.id);
const dispatcher = await repo.createUser("dispatcher", "Dispatcher");
const driver = await repo.createUser("tuan", "Tuan");
const channel = await repo.createChannel("fleet", "public");
await repo.addMember(channel.id, dispatcher.id);
await repo.addMember(channel.id, driver.id);

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

const heard = [];

function connect(url, who, sub) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${url}/v1/ws?token=${sub}`);
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "connection.ack") resolve(socket);
      else {
        heard.push({ who: who.trim(), type: frame.type });
        console.log(`  ${who} ← ${JSON.stringify(frame)}`);
      }
    });
  });
}

const a = await connect(G1, "dispatcher(G1)", await token("dispatcher"));
await connect(G2, "tuan(G2)      ", await token("tuan"));
console.log("both connected — dispatcher on G1, Tuan on G2\n");

console.log("dispatcher sends on G1:");
a.send(
  JSON.stringify({
    type: "message.send",
    payload: {
      idem_key: `k-${Date.now()}`,
      channel: channel.id,
      text: "which entrance?",
    },
  }),
);

setTimeout(() => {
  const tuanHeard = heard.filter(
    (f) => f.who === "tuan(G2)" && f.type === "message.created",
  );
  console.log(
    tuanHeard.length === 0
      ? "\nTuan heard nothing. Two servers, two conversations."
      : `\nTuan heard it (${tuanHeard.length} message.created). Two servers, one conversation.`,
  );
  process.exit(0);
}, 1200);
