// The chapter 3.2 walk, as a script (so the transcript in the chapter is
// reproducible rather than decorative).
//
// It follows the path a reader actually takes: mint a key, send with it, turn
// it into an end-user token, open a socket with THAT, and then present each
// credential where the other belongs. The last two steps are the point — the
// SRS calls confusing the two the most common first-integration failure, and
// this prints both refusals rather than describing them.
//
//   docker compose up -d --wait postgres redis
//   pnpm build
//   node services/api/dist/main.js &        # :4000
//   node services/gateway/dist/main.js &    # :4001
//   node scripts/credential-walk.mjs
import WebSocket from "ws";

import { createDb, createPool } from "../services/api/dist/db/client.js";
import {
  createApiKey,
  createEnvironment,
  Repository,
} from "../services/api/dist/db/repository.js";

const API = process.env.RELAY_API_URL ?? "http://127.0.0.1:4000";
const GATEWAY = process.env.RELAY_GATEWAY_URL ?? "ws://127.0.0.1:4001";

const show = (label, value) => console.log(`${label.padEnd(26)} ${value}`);
/** Credentials are TRUNCATED on the way to the terminal. A walk whose output
 * ends up pasted into a chapter must not carry a working secret with it
 * (NFR-SEC-06), and showing the shape is the part that teaches anything. */
const brief = (credential) => `${credential.slice(0, 18)}…`;

const db = createDb(createPool());
const env = await createEnvironment(db, {
  name: `credential-walk-${Date.now()}`,
});
const repo = new Repository(db, env.id);
const tuan = await repo.createUser("tuan", "Tuan");
const channel = await repo.createChannel("fleet", "public");
await repo.addMember(channel.id, tuan.id);

// ── 1. the application's credential ─────────────────────────────────────────
const key = await createApiKey(db, { environmentId: env.id, name: "walk" });
show("api key (shown once)", brief(key.credential));
show("its prefix", key.prefix);

const sent = await fetch(`${API}/v1/channels/${channel.id}/messages`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key.credential}`,
  },
  body: JSON.stringify({ text: "B2, north ramp" }),
});
show("POST with the key", `${sent.status} seq=${(await sent.json()).seq}`);

// ── 2. the end user's credential ────────────────────────────────────────────
const minted = await fetch(`${API}/auth/dev-token`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key.credential}`,
  },
  body: JSON.stringify({ user: "tuan" }),
});
const { token, expires_at } = await minted.json();
show("dev-token", `${minted.status} expires ${expires_at}`);

const heard = await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${GATEWAY}/v1/ws?token=${token}`);
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "connection.ack") {
      show("socket with the token", `open as ${frame.payload.user}`);
      socket.close();
      resolve(frame.payload.user);
    }
  });
  socket.on("close", (code) => {
    if (code !== 1000 && code !== 1005) reject(new Error(`closed ${code}`));
  });
  setTimeout(() => reject(new Error("no ack within 5s")), 5_000);
});

// ── 3. each credential where the other belongs ──────────────────────────────
// The mistake, both ways round. Neither answer is a generic "unauthorized":
// one names the classes, the other is a close code a client can act on.
const wrongWay = await fetch(`${API}/auth/dev-token`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ user: "tuan" }),
});
const refusal = await wrongWay.json();
show("token → key-only route", `${wrongWay.status} ${refusal.code}`);
console.log(`${"".padEnd(26)} "${refusal.message}"`);

const keyOnSocket = await new Promise((resolve) => {
  const socket = new WebSocket(`${GATEWAY}/v1/ws?token=${key.credential}`);
  socket.on("close", (code) => resolve(code));
  socket.on("error", () => undefined);
});
show("key → socket", `closed ${keyOnSocket}`);

console.log(`\nheard as ${heard}; both credentials worked, both refusals held.`);
process.exit(0);
