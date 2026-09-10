// Clear the lane's JetStream debris, so a run does not pay for every run before it.
//
// `stream-info.mjs` beside this file can READ the state this clears, and until now
// nothing could clear it. The consumer chapter's close-out needed exactly that: a
// durable consumer per test, left behind, each one paying a full stream scan on a
// stream nothing drains. Measured while writing this — 31 durables across two streams,
// on 1,146 messages nothing reads — and the same battery costs 457s against 400s on a
// lane that has been reset. Twelve and a half per cent, for no change to a line of code.
//
// A DESTRUCTIVE SCRIPT NEEDS A GUARD, AND THE GUARD HAS TO BE CHECKABLE. "Refuse
// anything that does not look like the lane" is not: every heuristic for it — port
// 15432, a database named `relay`, a localhost host — is wrong on somebody's machine,
// and a guard wrong in the permissive direction deletes a customer's rows. "Looks like
// the lane" is not checkable; "you typed the flag" is. So the guard is a flag, and
// `reset-lane.itest.ts` asserts the flag is load-bearing rather than decorative.
//
// AND NOW IT TOUCHES ONE TABLE, WHICH ARRIVED WITH THIS CHAPTER. The harness chapter
// wrote the broker half and said the rest would come with the table: `webhook_deliveries`
// is created here, it is the table that accumulates worst, and a script that deleted
// from a table the tree did not have would have been a script nobody could run.
//
// ONE TABLE, NAMED. Not "every table that looks like debris" — that is the same
// uncheckable guard the flag exists instead of. Organisations, environments, users,
// channels and messages are untouched, and the refusal below says so.
import { connect } from "../services/api/node_modules/nats/lib/src/mod.js";
import pg from "../services/api/node_modules/pg/lib/index.js";

const FLAG = "--yes-this-is-my-test-lane";
if (!process.argv.includes(FLAG)) {
  console.error(
    `reset-lane: refusing to run without ${FLAG}.\n` +
      `This purges every JetStream stream, deletes every durable consumer, and removes\n` +
      `webhook_deliveries left pending by runs that have ended. It does not touch any\n` +
      `organisation, environment, user, channel or message.\n` +
      `\n  node scripts/reset-lane.mjs ${FLAG}\n`,
  );
  process.exit(2);
}

const natsUrl = process.env.RELAY_NATS_URL ?? "nats://127.0.0.1:4222";
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

/** Deliveries younger than this belong to a run that may still be going. A run's own
 *  rows are seconds old, and a reset that raced a live suite would look like the
 *  platform losing deliveries. */
const STALE_AFTER = "30 minutes";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://relay:relay@localhost:15432/relay";
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
// `relay.allow_global` is the guard's exemption, and this IS a deliberate global
// operation on one table. Naming that table is how the mechanism is meant to be used:
// an unnamed attempt is refused, which is the guard doing its job rather than an
// obstacle to route around.
await client.query(`SET relay.allow_global = 'webhook_deliveries'`);
const { rowCount } = await client.query(
  `DELETE FROM webhook_deliveries
    WHERE state = 'pending' AND created_at < now() - interval '${STALE_AFTER}'`,
);
console.log(`  webhook_deliveries: ${rowCount ?? 0} stale pending rows deleted`);
await client.end();
process.exit(0);
