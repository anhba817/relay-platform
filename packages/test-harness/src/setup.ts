import { relative } from "node:path";

import pg from "pg";
import { beforeAll, expect } from "vitest";

import { EXEMPT_FILES, exemptTables } from "./exempt.js";
import { plant, sentinelFor } from "./sentinel.js";

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
// (FR-026, research R14).
//
// Bait planting stays in `beforeAll`, because it is asynchronous database work.

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
 * indistinguishable from the flakiness this feature removes (FR-020, research R10).
 *
 * The connection string rather than the pool's config object, because that needs no
 * change to `createPool()`, a product function every service calls. */
function withExemption(url: string, tables: readonly string[] | "all"): string {
  const u = new URL(url);
  const value = tables === "all" ? "all" : tables.join(",");
  u.searchParams.set("options", `-c relay.allow_global=${value}`);
  return u.toString();
}

const BASE_URL = process.env["DATABASE_URL"];
if (TABLES !== null && TABLES.length > 0 && BASE_URL !== undefined) {
  process.env["DATABASE_URL"] = withExemption(BASE_URL, TABLES);
}

// ---------------------------------------------------------------------------
// Module scope, part 2: a non-exempt file may not run a relay.
// ---------------------------------------------------------------------------

/** Both relays catch and log their own errors, so a refusal raised inside one is a
 * log line and a green lane — the guard's sharpest limitation (research R13). Every
 * suite that spawns an api child sets these off today; that is a convention in four
 * files, and this makes it checked (FR-025). */
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
  // failure research R4 measured (FR-022). The config that wants it says so.
  if (process.env["RELAY_HARNESS_BAIT"] !== "on") return;
  if (BASE_URL === undefined) return;

  // A DEDICATED CLIENT THAT NEVER ENTERS THE SUITE'S POOL. Deleting a sentinel row
  // is exactly what the guard forbids, so planting needs the exemption — and a
  // connection carrying it that a test later reused would leave that test unguarded
  // (FR-024, research R12).
  // `all`: planting deletes across every guarded table, which is the one job that
  // genuinely needs a blanket.
  const seeder = new pg.Client({
    connectionString: withExemption(BASE_URL, "all"),
  });
  await seeder.connect();
  try {
    await plant(seeder, sentinelFor(FILE));
  } finally {
    await seeder.end();
  }
});
