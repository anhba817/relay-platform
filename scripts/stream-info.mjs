// What the stream actually holds and how it is actually configured
// (chapter 3.4). The chapter quotes the broker, not the config file — a
// configuration that was written is not the same as a configuration that was
// applied, and the difference is exactly what this chapter is about.
//
//   docker compose up -d --wait nats
//   RELAY_NATS_URL=nats://localhost:14222 node scripts/stream-info.mjs
//   RELAY_NATS_URL=nats://localhost:14222 node scripts/stream-info.mjs ANALYTICS
//
// The stream is an ARGUMENT as of chapter 3.6, defaulting to the one stream that
// existed when this was written. It had `"EVENTS"` in three places, and 3.6's
// quickstart asks the reader to inspect `ANALYTICS` — which would have printed
// the wrong stream's configuration and passed, since every field it shows exists
// on both. A validation step that cannot fail is worse than no step.
import { connect } from "../services/api/node_modules/nats/lib/src/mod.js";

const stream = process.argv[2] ?? "EVENTS";
const url = process.env.RELAY_NATS_URL ?? "nats://127.0.0.1:4222";
const nc = await connect({ servers: url });
const jsm = await nc.jetstreamManager();

const seconds = (ns) => (ns === 0 ? "unlimited" : `${ns / 1e9}s`);
const bytes = (n) => (n === -1 ? "unlimited" : `${(n / 1024 ** 3).toFixed(2)} GiB`);
const show = (label, value) => console.log(`${label.padEnd(20)} ${value}`);

const info = await jsm.streams.info(stream).catch(() => null);
if (info === null) {
  // Named loudly rather than crashed on. A stream that does not exist yet is the
  // ordinary state before the api has started once, and "no such stream" is a
  // more useful answer than a broker client's stack trace.
  console.error(
    `no stream named ${stream}. The api CREATES its streams on first publish —\n` +
      "start it once, or check the name (EVENTS, DELIVERIES, ANALYTICS).",
  );
  await nc.drain();
  process.exit(1);
}
const c = info.config;

console.log(`stream ${stream}`);
show("  messages", info.state.messages);
show("  bytes", `${(info.state.bytes / 1024 ** 2).toFixed(1)} MiB`);
show("  consumers", info.state.consumer_count);
console.log("configuration");
show("  subjects", JSON.stringify(c.subjects));
show("  retention", `${c.retention}   (immutable once created)`);
show("  storage", `${c.storage}    (immutable once created)`);
show("  replicas", c.num_replicas);
show(
  "  max_age",
  stream === "EVENTS"
    ? `${seconds(c.max_age)}   (NFR-REL-08 floor: 86400s)`
    : seconds(c.max_age),
);
show("  max_bytes", bytes(c.max_bytes));
show("  discard", `${c.discard}     (at the bound, drop the OLDEST)`);
show("  duplicate_window", `${seconds(c.duplicate_window)}   (the broker's dedupe, not ours)`);

console.log("consumers");
for await (const ci of jsm.consumers.list(stream)) {
  show(
    `  ${ci.name}`,
    `pending=${ci.num_pending} ack_pending=${ci.num_ack_pending} redelivered=${ci.num_redelivered} max_deliver=${ci.config.max_deliver ?? "-"}`,
  );
}

await nc.drain();
process.exit(0);
