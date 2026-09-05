// Return the test lane to an empty state (feature 043, FR-005).
//
// `stream-info.mjs` beside this file can READ the state this clears, and until now
// nothing could clear it. Chapter 3.24's close-out found the lane holding 56,193
// messages and 216 durable consumers on DELIVERIES, with 27,847 webhook deliveries due
// — enough that `dispatcher-deliver` sat permanently at its 100-message ack ceiling and
// every dispatcher test reported `expected 0 to be greater than 0`. Clearing it took
// two hand-written scripts and an approval, twice.
//
//   node scripts/reset-lane.mjs --yes-this-is-my-test-lane
//
// THE FLAG IS THE GUARD, AND IT IS EXPLICIT ON PURPOSE. The obvious alternative is to
// inspect `DATABASE_URL` and refuse anything that does not look like the lane — port
// 15432, a database named `relay`, a host of localhost. Every one of those heuristics
// is wrong on somebody's machine, and a guard that is wrong in the permissive direction
// deletes a customer's rows. "Looks like the lane" is not checkable; "you typed the
// flag" is.
//
// THE SEEDED DEMO TENANT SURVIVES. The constitution requires `docker compose up` to
// bring the stack up "including a seeded demo tenant", so a reset that removed it would
// break the one command the constitution names. This script deletes lane DEBRIS —
// purged streams, orphaned durables, and webhook deliveries left pending by runs that
// ended — and touches no organisation, environment, user, channel or message.
import { connect } from "../services/api/node_modules/nats/lib/src/mod.js";
import pg from "../services/api/node_modules/pg/lib/index.js";

const FLAG = "--yes-this-is-my-test-lane";
if (!process.argv.includes(FLAG)) {
  console.error(
    `reset-lane: refusing to run without ${FLAG}.\n` +
      `This purges every JetStream stream, deletes every durable consumer, and removes\n` +
      `webhook_deliveries left pending by runs that have ended. It does not touch the\n` +
      `seeded demo tenant, or any organisation, environment, user, channel or message.\n` +
      `\n  node scripts/reset-lane.mjs ${FLAG}\n`,
  );
  process.exit(2);
}

/** Deliveries younger than this belong to a run that may still be going. A run's own
 *  rows are seconds old; the debris chapter 3.24 found went back nine days. */
const STALE_AFTER = "30 minutes";

const natsUrl = process.env.RELAY_NATS_URL ?? "nats://127.0.0.1:4222";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://relay:relay@localhost:15432/relay";

const nc = await connect({ servers: natsUrl });
const jsm = await nc.jetstreamManager();

for await (const s of jsm.streams.list()) {
  const name = s.config.name;
  const before = s.state.messages;
  const names = [];
  for await (const c of jsm.consumers.list(name)) names.push(c.name);
  let deleted = 0;
  for (const c of names) {
    // A consumer another process is actively using can refuse; that is information,
    // not an error, and it is reported rather than swallowed.
    try {
      await jsm.consumers.delete(name, c);
      deleted++;
    } catch (error) {
      console.log(`  kept ${name}/${c}: ${String(error)}`);
    }
  }
  await jsm.streams.purge(name);
  const after = await jsm.streams.info(name);
  console.log(
    `  ${name}: ${before} -> ${after.state.messages} messages, ` +
      `${deleted}/${names.length} consumers deleted`,
  );
}
await nc.drain();

// `relay.allow_global` is feature 030's exemption, and this IS a deliberate global
// operation on one table. Naming that table is how the mechanism is meant to be used —
// the guard refused an unnamed attempt during chapter 3.24's close-out because the
// statement touched a sentinel row a test had planted and left behind, which is the
// guard doing its job.
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
await client.query(`SET relay.allow_global = 'webhook_deliveries'`);
const { rowCount } = await client.query(
  `DELETE FROM webhook_deliveries
   WHERE state = 'pending' AND created_at < now() - interval '${STALE_AFTER}'`,
);
const { rows } = await client.query(
  `SELECT count(*)::int AS n FROM webhook_deliveries
   WHERE state = 'pending' AND next_attempt_at <= now()`,
);
console.log(`  webhook_deliveries: ${rowCount} stale pending rows deleted`);
console.log(`  webhook_deliveries: ${rows[0].n} due now`);
await client.end();
