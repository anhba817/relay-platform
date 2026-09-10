import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import pg from "pg";
import { describe, expect, it } from "vitest";

import { databaseUrl } from "./db-url.js";

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
// 3. AND NOW IT CLEARS ONE TABLE, WHICH ARRIVED WITH THIS CHAPTER. The harness chapter
//    left this assertion owed and said which chapter owed it. `webhook_deliveries` is
//    that table.
//
//    ONE INSTANT, CAPTURED BEFORE THE SCRIPT RUNS, AND BOTH SIDES MEAN IT. The obvious
//    assertion re-evaluates `now()`: the script deletes what was stale when IT ran, and
//    a test counting what is stale afterwards includes every row that aged across the
//    threshold in between. Published's battery failed exactly there, twice, with the
//    script having done its job perfectly.
//
//    AND IT COUNTS STALENESS, NOT "DUE". "Due" would mean `next_attempt_at <= now()`,
//    which a run that has just finished violates legitimately — `STALE_AFTER` exists so
//    a reset cannot race a live suite. A test of a script owes a property of what the
//    SCRIPT DID, not of the table.

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
    // WHAT IT REMOVES AND WHAT IT DOES NOT, both asserted, because the second half is
    // the one a reader needs before typing the flag.
    //
    // ON SUBSTANCE, NOT ON A LINE BREAK. This asserted `"does\nnot touch Postgres"` and
    // went red the moment the message was rewrapped by the chapter that gave the script
    // a table — a test of a wording rather than of a claim.
    expect(stderr).toContain("webhook_deliveries left pending");
    expect(stderr).toContain("does not touch any");
    expect(stderr).toContain("channel or message");
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

  it("removes a stale pending delivery it planted, and nothing a tenant owns", async () => {
    // PLANTED, BECAUSE THE OBVIOUS VERSION OF THIS TEST IS VACUOUS. It was written as
    // "run the script, then count stale rows, expect zero" — and it PASSED with the
    // DELETE replaced by a no-op, because a lane that was just reset has no stale rows
    // either way. Falsified before it was believed, which is the only reason anyone
    // knows. So this plants the row it is about to have deleted, and asserts it present
    // first.
    const client = new pg.Client({ connectionString: databaseUrl() });
    await client.connect();
    const planted = randomUUID();
    try {
      // ORGANISATIONS THAT EXISTED WHEN THE SCRIPT RAN, pinned to one instant — the
      // same correction this file already made for staleness, in the other direction.
      //
      // This counted the whole table before and after. The claim is "the reset removed
      // no organisation", which is genuinely global, so the count has to be; what it
      // must NOT be is open at the far end. Turbo runs two lanes at a time, so the api
      // lane provisions tenants while this runs, and a count that includes them says
      // `expected 20140 to be 20139` about a script that deleted nothing.
      //
      // Pinning the instant keeps the global claim and closes the window: rows created
      // after `pinned` are somebody else's and are not what the assertion is about.
      const pinned = (
        await client.query<{ now: string }>("SELECT now()::text AS now")
      ).rows[0]!.now;
      const orgs = async () =>
        (
          await client.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM organisations WHERE created_at <= $1",
            [pinned],
          )
        ).rows[0]!.n;

      // AN ENVIRONMENT OF THIS TEST'S OWN, built from the top. Reusing an existing one
      // was the first attempt and `environments_application_kind_unique` refused the
      // second `development` row for an application that already had one — which is the
      // constraint doing its job. A fixture that borrowed somebody else's environment
      // would also be writing endpoints into a tenant it does not own, which is the
      // shape this whole harness exists to make impossible.
      const org = randomUUID();
      const app = randomUUID();
      const envId = randomUUID();
      await client.query("INSERT INTO organisations (id, name) VALUES ($1, $2)", [
        org,
        `reset-lane-itest-${org.slice(0, 8)}`,
      ]);
      await client.query(
        "INSERT INTO applications (id, name, organisation_id) VALUES ($1, $2, $3)",
        [app, "reset-lane-itest", org],
      );
      await client.query(
        `INSERT INTO environments (id, application_id, kind, signing_secret)
         VALUES ($1, $2, 'development', 'reset-lane-itest')`,
        [envId, app],
      );
      const env = { id: envId };
      const endpoint = randomUUID();
      await client.query(
        `INSERT INTO webhook_endpoints (id, environment_id, url, secret_ciphertext, event_types)
         VALUES ($1, $2, 'https://reset-lane.invalid/x', 'x', '["message.created"]'::jsonb)`,
        [endpoint, env!.id],
      );
      await client.query(
        `INSERT INTO webhook_deliveries
           (id, environment_id, endpoint_id, event_id, payload, state, created_at)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'pending', now() - interval '2 hours')`,
        [planted, env!.id, endpoint, randomUUID()],
      );

      const isThere = async () =>
        (
          await client.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM webhook_deliveries WHERE id = $1",
            [planted],
          )
        ).rows[0]!.n;
      expect(await isThere(), "the probe planted no delivery").toBe(1);

      // COUNTED AFTER THIS TEST'S OWN ORGANISATION EXISTS, so the number the script is
      // measured against includes it — otherwise a script that deleted exactly one
      // organisation would balance against the one just inserted and read as unchanged.
      const before = await orgs();
      await run("node", [SCRIPT, "--yes-this-is-my-test-lane"]);

      expect(await isThere(), "the planted stale delivery survived the reset").toBe(0);
      // NOTHING A TENANT OWNS. The script names one table; every organisation it did not
      // name is still there, which is the claim its own refusal message makes.
      expect(await orgs(), "the reset removed an organisation").toBe(before);
    } finally {
      await client.end();
    }
  }, 60_000);
});
