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
// AND IT TOUCHES NO ROWS. This clears the BROKER only — purged streams and orphaned
// durables. Postgres accumulates too, and the tables that accumulate are not all in
// this tree yet: `webhook_deliveries` arrives with the webhook chapter, which is where
// its half of this script arrives with it. A script that deleted from a table this
// tree does not have would be a script nobody could run.
import { connect } from "../services/api/node_modules/nats/lib/src/mod.js";

const FLAG = "--yes-this-is-my-test-lane";
if (!process.argv.includes(FLAG)) {
  console.error(
    `reset-lane: refusing to run without ${FLAG}.\n` +
      `This purges every JetStream stream and deletes every durable consumer. It does\n` +
      `not touch Postgres at all: no organisation, environment, user, channel or\n` +
      `message, and nothing a seeded tenant owns.\n` +
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
process.exit(0);
