import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

// Feature 043 — the two properties `reset-lane.mjs` has to hold (FR-005).
//
// The script purges every JetStream stream, deletes every durable consumer, and removes
// webhook deliveries left pending by runs that ended. Chapter 3.24's close-out needed
// exactly that and had no command for it: clearing the lane took two hand-written
// scripts and an approval, twice.
//
// A destructive script needs a guard, and the guard has to be checkable. "Refuse
// anything that does not look like the lane" is not — every heuristic for it (port
// 15432, a database named `relay`, a localhost host) is wrong on somebody's machine, and
// a guard wrong in the permissive direction deletes a customer's rows. So the guard is
// a flag, and this asserts the flag is load-bearing rather than decorative.
//
// The second property is the one the CONSTITUTION cares about: `docker compose up` must
// bring the stack up "including a seeded demo tenant". A reset that removed it would
// break the one command the constitution names by title.

describe("reset-lane.mjs", () => {
  it("refuses to run without the opt-in flag, and says why", async () => {
    // `execFile` rejects on a non-zero exit, which is the assertion: a guard that
    // printed a warning and proceeded would resolve here and pass a weaker test.
    await expect(run("node", [SCRIPT])).rejects.toMatchObject({ code: 2 });

    const failure = await run("node", [SCRIPT]).catch((e: { stderr: string }) => e);
    expect((failure as { stderr: string }).stderr).toContain("--yes-this-is-my-test-lane");
    // The refusal states what would have happened. A guard that only says "refused"
    // teaches the reader to pass the flag without knowing what it does.
    expect((failure as { stderr: string }).stderr).toContain("seeded demo tenant");
  }, 30_000);

  it("clears lane debris and leaves the seeded demo tenant alone", async () => {
    const client = new pg.Client({ connectionString: databaseUrl() });
    await client.connect();
    try {
      const count = async () =>
        (
          await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM organisations WHERE name = $1`,
            [process.env["RELAY_DEMO_TENANT_NAME"] ?? "demo"],
          )
        ).rows[0]!.n;

      const before = await count();
      await run("node", [SCRIPT, "--yes-this-is-my-test-lane"]);
      expect(await count()).toBe(before);

      // And nothing due: the point of the reset is that the delivery relay has no
      // backlog to republish, which is what starved the dispatcher lane in 3.24.
      const due = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM webhook_deliveries
         WHERE state = 'pending' AND created_at < now() - interval '30 minutes'`,
      );
      expect(due.rows[0]!.n).toBe(0);
    } finally {
      await client.end();
    }
  }, 60_000);
});
