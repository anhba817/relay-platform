// What the stream actually holds and how it is actually configured
// (chapter 3.4). The chapter quotes the broker, not the config file — a
// configuration that was written is not the same as a configuration that was
// applied, and the difference is exactly what this chapter is about.
//
//   docker compose up -d --wait nats
//   RELAY_NATS_URL=nats://localhost:14222 node scripts/stream-info.mjs
import { connect } from "../services/api/node_modules/nats/lib/src/mod.js";

const url = process.env.RELAY_NATS_URL ?? "nats://127.0.0.1:4222";
const nc = await connect({ servers: url });
const jsm = await nc.jetstreamManager();

const seconds = (ns) => (ns === 0 ? "unlimited" : `${ns / 1e9}s`);
const bytes = (n) => (n === -1 ? "unlimited" : `${(n / 1024 ** 3).toFixed(2)} GiB`);
const show = (label, value) => console.log(`${label.padEnd(20)} ${value}`);

const info = await jsm.streams.info("EVENTS");
const c = info.config;

console.log("stream EVENTS");
show("  messages", info.state.messages);
show("  bytes", `${(info.state.bytes / 1024 ** 2).toFixed(1)} MiB`);
show("  consumers", info.state.consumer_count);
console.log("configuration");
show("  subjects", JSON.stringify(c.subjects));
show("  retention", `${c.retention}   (immutable once created)`);
show("  storage", `${c.storage}    (immutable once created)`);
show("  replicas", c.num_replicas);
show("  max_age", `${seconds(c.max_age)}   (NFR-REL-08 floor: 86400s)`);
show("  max_bytes", bytes(c.max_bytes));
show("  discard", `${c.discard}     (at the bound, drop the OLDEST)`);
show("  duplicate_window", `${seconds(c.duplicate_window)}   (the broker's dedupe, not ours)`);

console.log("consumers");
for await (const ci of jsm.consumers.list("EVENTS")) {
  show(
    `  ${ci.name}`,
    `pending=${ci.num_pending} ack_pending=${ci.num_ack_pending} redelivered=${ci.num_redelivered} max_deliver=${ci.config.max_deliver ?? "-"}`,
  );
}

await nc.drain();
process.exit(0);
