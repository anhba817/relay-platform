import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// BY PATH, FOR THE REASON THIS PACKAGE'S OWN HEADER GIVES. Adding `nats` to its
// dependencies would change `pnpm-lock.yaml`, and the lock is a generated file every
// later chapter also touches — a dependency added here to test a script costs a
// conflict in every chapter after it. The script itself reaches for the api's copy
// the same way and for the same reason.
// NO `eslint-disable` HERE, and it was written with one. The rule restricts `pg`,
// `drizzle-orm` and `ioredis`; `nats` is on none of those lists, so the directive was
// unused and `--report-unused-disable-directives` said so. A suppression for a rule
// that never fires is a claim about a restriction that does not exist.
import { connect } from "../../../services/api/node_modules/nats/lib/src/mod.js";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
  "reset-lane.mjs",
);

// THE TWO PROPERTIES `reset-lane.mjs` HAS TO HOLD.
//
// The script purges every JetStream stream and deletes every durable consumer. This
// lane needed exactly that and had no command for it: each test that builds a consumer
// runtime leaves a durable behind, every one of them then pays a full scan of a stream
// nothing drains, and the cost is monotonic. Measured while writing it: 31 durables on
// 1,146 messages, and 457 seconds against 400 for the same battery on a reset lane.
//
// 1. THE FLAG IS LOAD-BEARING. A destructive script's guard has to be checkable, and
//    "does this look like the lane" is not — every heuristic for it is wrong on
//    somebody's machine. A flag is checkable, and this asserts it refuses without one
//    AND that the refusal says what would have happened. A guard that only says
//    "refused" teaches the reader to pass the flag without knowing what it does.
//
// 2. IT ACTUALLY PURGES. The obvious version of this test runs the script and asserts
//    it exited 0, which passes against a script that does nothing at all. So this one
//    plants what it is about to have deleted: a stream with messages on it and a
//    durable consumer, both named for this test, asserted present, then asserted gone.
//
// WHAT THIS DOES NOT ASSERT, and the reason is worth having: that Postgres is untouched.
// The script does not open a connection to it, so there is nothing to test — a "no rows
// were deleted" assertion against code that cannot delete rows is the vacuous shape
// this file's second property exists to avoid. When the webhook chapter gives the script
// a table to purge, that is the chapter that owes the assertion.

const NATS = process.env["RELAY_NATS_URL"] ?? "nats://127.0.0.1:4222";
const STREAM = "RESETLANE_ITEST";
const DURABLE = "resetlane-itest-durable";

describe("reset-lane.mjs", () => {
  it("refuses to run without the opt-in flag, and says what it would have done", async () => {
    // `execFile` rejects on a non-zero exit, which IS the assertion: a guard that
    // printed a warning and proceeded would resolve here and pass a weaker test.
    await expect(run("node", [SCRIPT])).rejects.toMatchObject({ code: 2 });

    const failure = await run("node", [SCRIPT]).catch((e: { stderr: string }) => e);
    const stderr = (failure as { stderr: string }).stderr;
    expect(stderr).toContain("--yes-this-is-my-test-lane");
    expect(stderr).toContain("purges every JetStream stream");
    // It says what it does NOT touch, which is the half a reader needs before running it.
    expect(stderr).toContain("does\nnot touch Postgres");
  }, 30_000);

  it("purges a stream and deletes a durable it can see, having planted both", async () => {
    const nc = await connect({ servers: NATS });
    const jsm = await nc.jetstreamManager();
    try {
      await jsm.streams.add({ name: STREAM, subjects: [`${STREAM}.>`] }).catch(() => undefined);
      await jsm.consumers
        .add(STREAM, { durable_name: DURABLE, ack_policy: "explicit" as never })
        .catch(() => undefined);
      const js = nc.jetstream();
      for (let i = 0; i < 3; i++) await js.publish(`${STREAM}.probe`, new Uint8Array([i]));

      // THE POSITIVE CONTROL. Without it the assertions below pass against a broker
      // that was already empty, which is what an unreset lane never is and a reset one
      // always is — so the test would be green in exactly the case it exists to catch.
      const planted = await jsm.streams.info(STREAM);
      expect(planted.state.messages, "the probe planted no messages").toBeGreaterThan(0);
      const durables = [];
      for await (const c of jsm.consumers.list(STREAM)) durables.push(c.name);
      expect(durables, "the probe planted no durable").toContain(DURABLE);

      await run("node", [SCRIPT, "--yes-this-is-my-test-lane"]);

      const after = await jsm.streams.info(STREAM);
      expect(after.state.messages, "messages survived the purge").toBe(0);
      const left = [];
      for await (const c of jsm.consumers.list(STREAM)) left.push(c.name);
      expect(left, "the durable survived the reset").not.toContain(DURABLE);
    } finally {
      await jsm.streams.delete(STREAM).catch(() => undefined);
      await nc.drain();
    }
  }, 60_000);
});
