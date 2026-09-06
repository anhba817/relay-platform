// NFR-SCL-01: "sustain 10,000 concurrent WebSocket connections per gateway instance."
//
// ONE gateway instance, one api, and as many real client sockets as asked for. What is
// measured is the GATEWAY's cost, so the api and the load generator are noise to be kept
// out of the way rather than subjects.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { WebSocket } = require_(join(REPO, "services", "gateway", "node_modules", "ws"));

const seed = JSON.parse(readFileSync(process.env.SCALE_SEED, "utf8"));
const TARGET = Number(process.env.SCALE_CONNECTIONS ?? 1000);
const CHANNELS_IN_PLAY = Number(process.env.SCALE_CHANNELS_IN_PLAY ?? seed.channels.length);
const children = [];

/** The port the OS gave a child, read from its own listening line — the same mechanism
 *  feature 043 put in every lane, and for the same reason: nothing here picks a number. */
function boundPort(child, label, timeoutMs = 60_000) {
  let out = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} never listened\n${out}`)), timeoutMs);
    const onData = (c) => {
      out += String(c);
      const m = /"msg":"listening","port":(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`${label} exited ${code}\n${out}`)); });
  });
}

async function waitHealthy(url) {
  for (let i = 0; i < 300; i += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never healthy: ${url}`);
}

const api = spawn("node", [join(REPO, "services", "api", "dist", "main.js")], {
  env: { ...process.env, PORT: "0", RELAY_OUTBOX_RELAY: "off", RELAY_NOTIFICATION_RELAY: "off",
         RELAY_EVENT_CONSUMER: "off", RELAY_DELIVERY_RELAY: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(api);
const apiPort = await boundPort(api, "api");
const apiUrl = `http://127.0.0.1:${apiPort}`;
await waitHealthy(`${apiUrl}/healthz`);

const gw = spawn("node", [join(REPO, "services", "gateway", "dist", "main.js")], {
  env: { ...process.env, PORT: "0", RELAY_API_URL: apiUrl },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(gw);
const gwPort = await boundPort(gw, "gateway");
await waitHealthy(`http://127.0.0.1:${gwPort}/healthz`);

/** RSS of one process, from /proc — the gateway's own cost, not the box's. */
const rssMb = (pid) => {
  try {
    const kb = Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]);
    return Math.round(kb / 1024);
  } catch { return -1; }
};

const baselineRss = rssMb(gw.pid);

// Tokens first. Minting is api work and would otherwise land inside the connection timing.
// ONE CONNECTION PER USER BY DEFAULT. `MAX_CONNECTIONS_PER_USER = 5`, so reusing a
// token five times sits exactly on the cap and leaves no headroom for a slot claim
// that races or a leftover from the previous run — which is what made an earlier
// ladder report `4004 connection_limit_reached` and read like a capacity limit.
const PER_USER = Number(process.env.SCALE_CONNS_PER_USER ?? 1);
const usersNeeded = Math.ceil(TARGET / PER_USER);
if (usersNeeded > seed.users.length) {
  throw new Error(`need ${usersNeeded} users, seed has ${seed.users.length}`);
}
const tokens = [];
for (let i = 0; i < usersNeeded; i += 1) {
  const res = await fetch(`${apiUrl}/auth/dev-token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${seed.credential}` },
    body: JSON.stringify({ user: seed.users[i % seed.users.length], ttl_seconds: 7200 }),
  });
  if (!res.ok) throw new Error(`dev-token ${res.status}: ${await res.text()}`);
  tokens.push((await res.json()).token);
}

let open = 0, failed = 0, closed = 0;
const errors = new Map();
const closeCodes = new Map();
const serverErrors = new Map();
const sockets = [];
const t0 = Date.now();

// Opened in waves. All at once is a SYN flood against somaxconn=4096 and measures the
// accept queue rather than the gateway.
const WAVE = 250;
for (let i = 0; i < TARGET; i += WAVE) {
  const batch = [];
  for (let j = i; j < Math.min(i + WAVE, TARGET); j += 1) {
    const token = tokens[Math.floor(j / PER_USER) % tokens.length];
    batch.push(new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/v1/ws?token=${token}`);
      let settled = false;
      const done = (ok, why) => {
        if (settled) return; settled = true;
        if (ok) { open += 1; sockets.push(ws); } else { failed += 1; errors.set(why, (errors.get(why) ?? 0) + 1); }
        resolve();
      };
      ws.on("open", () => done(true));
      ws.on("error", (e) => done(false, String(e.message).slice(0, 60)));
      ws.on("close", (code, reason) => {
        if (settled) { closed += 1; const k = `${code} ${String(reason).slice(0,40)}`; closeCodes.set(k, (closeCodes.get(k) ?? 0) + 1); }
        else done(false, `close ${code}`);
      });
      // The error FRAME, which is a different thing from a transport error: the gateway
      // says why before it closes, and that sentence is the measurement.
      ws.on("message", (raw) => {
        try {
          const f = JSON.parse(String(raw));
          if (f.type === "error") { const k = f.payload?.code ?? "?"; serverErrors.set(k, (serverErrors.get(k) ?? 0) + 1); }
        } catch { /* not json */ }
      });
      setTimeout(() => done(false, "timeout 20s"), 20_000);
    }));
  }
  await Promise.all(batch);
}
const connectMs = Date.now() - t0;

// SUSTAIN, NOT OPEN. NFR-SCL-01's verb is "sustain", and a socket that is accepted and
// then dropped satisfies "open" while failing the clause. The gateway pings every 30 s and
// closes after 2 missed, so a hold longer than 60 s is what distinguishes the two.
const HOLD_MS = Number(process.env.SCALE_HOLD_MS ?? 3000);
const openedAfterConnect = open;
await new Promise((r) => setTimeout(r, HOLD_MS));
const survived = openedAfterConnect - closed;

/** THE NUMBER THE SUBJECT-GRAMMAR QUESTION NEEDS. Five grammars each take their own
 *  Redis SUBSCRIBE per channel, so the cost of "a fabric per kind" is only visible from
 *  the broker's side. `PUBSUB CHANNELS` reports what is actually subscribed, which is the
 *  measurement rather than an inference from the source. */
const { Redis } = require_(join(REPO, "services", "gateway", "node_modules", "ioredis"));
const probe = new Redis(process.env.RELAY_REDIS_URL ?? "redis://localhost:6379");
const subjects = await probe.pubsub("CHANNELS");
const byPrefix = {};
for (const s of subjects) {
  const p = String(s).split(":")[0];
  byPrefix[p] = (byPrefix[p] ?? 0) + 1;
}
const redisClients = Number(
  (await probe.info("clients")).match(/connected_clients:(\d+)/)?.[1] ?? -1,
);
// What the subscriptions cost the BROKER, which is the half a gateway-side RSS cannot see.
const mem = await probe.info("memory");
const redisMemMb = Math.round(Number(mem.match(/used_memory:(\d+)/)?.[1] ?? 0) / 1024 / 1024);
await probe.quit();

console.log(JSON.stringify({
  target: TARGET, open, failed, closed,
  survived, holdMs: HOLD_MS,
  errors: Object.fromEntries(errors),
  closeCodes: Object.fromEntries(closeCodes),
  serverErrors: Object.fromEntries(serverErrors),
  connectMs,
  connectsPerSec: Math.round((open / connectMs) * 1000),
  gatewayRssMb: rssMb(gw.pid),
  baselineRssMb: baselineRss,
  kbPerConnection: open > 0 ? Math.round(((rssMb(gw.pid) - baselineRss) * 1024) / open) : 0,
  channelsInPlay: CHANNELS_IN_PLAY,
  connsPerUser: PER_USER,
  redisSubjects: subjects.length,
  redisSubjectsByPrefix: byPrefix,
  redisConnectedClients: redisClients,
  redisMemMb,
}));

for (const s of sockets) s.terminate();
for (const c of children) c.kill("SIGKILL");
process.exit(0);
