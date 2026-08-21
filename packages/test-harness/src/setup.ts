import { relative } from "node:path";

import pg from "pg";
import { beforeAll, expect } from "vitest";

import { databaseUrl } from "./db-url.js";
import { EXEMPT_FILES, exemptTables } from "./exempt.js";
import { plant, plantReaderBait, sentinelFor } from "./sentinel.js";

// Runs once per test file, before the test file is imported (feature 030).
//
// EVERYTHING THAT MUST HAPPEN AT MODULE SCOPE HAPPENS AT MODULE SCOPE, and the
// distinction is measured rather than stylistic. A setup file's top-level code runs
// before the test file's module scope — `setup-toplevel; testfile-module;` — and
// four suites create their database pool at module scope:
//
//   services/api/src/db/history-drift.itest.ts
//   services/api/src/db/repository.itest.ts
//   services/api/src/messages/history.itest.ts
//   services/api/src/messages/idempotency.itest.ts
//
// An exemption written in `beforeAll` would arrive after their pool already exists.
// None of the six exempt suites is written that way today, so nothing is currently
// broken by it — which is the same kind of luck this whole feature exists to remove
// (research R14).
//
// Bait planting stays in `beforeAll`, because it is asynchronous database work.
//
// PER-FILE PLANTING AND A PER-FILE SENTINEL ARE ONE DECISION, NOT TWO. No
// integration config overrides `fileParallelism`, so files in this lane run at the
// same time; planting into a shared sentinel would delete rows another file is
// mid-test against (research R12). And a one-shot `globalSetup` seeder protects
// whichever suite runs first and nothing after it — research R2 measured three of
// the four baits eaten in a single pass. The trigger is what makes the bait durable
// for a non-exempt file, so only the exempt suites can consume it, and they consume
// only the tables their entry names.

const PLATFORM = new URL("../../../", import.meta.url).pathname;

/** The file under test, as a repository-relative path. `expect.getState()` carries
 * it at module scope, not only inside a hook — which is what makes the per-file
 * sentinel possible. */
function testFile(): string {
  const abs = expect.getState().testPath;
  if (abs === undefined) {
    throw new Error("the harness cannot identify the file under test");
  }
  return relative(PLATFORM, abs).replace(/\\/g, "/");
}

const FILE = testFile();
const TABLES = exemptTables(FILE);
const EXEMPT = TABLES !== null;

// ---------------------------------------------------------------------------
// Module scope, part 1: the exemption.
// ---------------------------------------------------------------------------

/** The exemption travels as a CONNECTION OPTION, so every connection a pool opens
 * carries it. A `SET` issued through `pool.query()` lands on whichever connection
 * the pool hands out — measured at two of five checkouts, `["on",null,null,"on",
 * null]` — which would make an exempt suite fail two times in five, in a way
 * indistinguishable from the flakiness this feature removes (research R10).
 *
 * The connection string rather than the pool's config object, because that needs no
 * change to `createPool()`, a product function every service calls. */
function withExemption(url: string, tables: readonly string[] | "all"): string {
  const u = new URL(url);
  const value = tables === "all" ? "all" : tables.join(",");
  u.searchParams.set("options", `-c relay.allow_global=${value}`);
  return u.toString();
}

// `databaseUrl()`, not `process.env.DATABASE_URL`: every package in this workspace
// falls back to the compose stack's address when the variable is unset, and a
// harness that did not would be the one task in the repository requiring it
// (research R50). Writing the variable back means the suite's own `createPool()`
// reads the exemption too, which is the whole mechanism.
const BASE_URL = databaseUrl();
if (TABLES !== null && TABLES.length > 0) {
  process.env["DATABASE_URL"] = withExemption(BASE_URL, TABLES);
}

// ---------------------------------------------------------------------------
// Module scope, part 2: a non-exempt file may not run a relay.
// ---------------------------------------------------------------------------

/** Both relays catch and log their own errors, so a refusal raised inside one is a
 * log line and a green lane — the guard's sharpest limitation (research R13). Every
 * suite that spawns an api child sets these off today; that is a convention in four
 * files, and this makes it checked. */
const RELAY_FLAGS = [
  "RELAY_OUTBOX_RELAY",
  "RELAY_DELIVERY_RELAY",
  "RELAY_NOTIFICATION_RELAY",
  "RELAY_EVENT_CONSUMER",
] as const;

if (!EXEMPT) {
  const running = RELAY_FLAGS.filter(
    (f) => (process.env[f] ?? "on").toLowerCase() !== "off",
  );
  if (running.length > 0 && process.env["RELAY_HARNESS_BAIT"] === "on") {
    throw new Error(
      `${FILE} is not on the exempt list but leaves ${running.join(", ")} enabled. ` +
        `A relay catches its own errors, so a refusal raised inside one is a log ` +
        `line and a green lane. Switch them off, or add this file to ` +
        `packages/test-harness/src/exempt.ts with a reason — there are ` +
        `${EXEMPT_FILES.length} entries there today.`,
    );
  }
}

// ---------------------------------------------------------------------------
// beforeAll: the bait.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Bait goes only to the lanes where reader-shape faults live. Planting it in the
  // gateway and e2e lanes would change their workload for no return, which is the
  // failure research R4 measured. The config that wants it says so.
  if (process.env["RELAY_HARNESS_BAIT"] !== "on") return;

  // A DEDICATED CLIENT THAT NEVER ENTERS THE SUITE'S POOL. Deleting a sentinel row
  // is exactly what the guard forbids, so planting needs the exemption — and a
  // connection carrying it that a test later reused would leave that test unguarded
  // (research R12).
  // `all`: planting deletes across every guarded table, which is the one job that
  // genuinely needs a blanket.
  const seeder = new pg.Client({
    connectionString: withExemption(BASE_URL, "all"),
  });
  await seeder.connect();
  try {
    await plant(seeder, sentinelFor(FILE));
    // The shared sweep bait, re-enabled rather than re-created — see
    // READER_BAIT_OWNER. Every file does this, because every file may be the one
    // running alone against a database a previous sweep emptied.
    await plantReaderBait(seeder);
  } finally {
    await seeder.end();
  }
});
