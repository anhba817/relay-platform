#!/usr/bin/env node
// DR-17's weekly job, as a thin caller. The comparison lives in
// `services/api/src/metering/storage-reconcile.ts`; this constructs the three handles and
// prints. `reconcile-usage.mjs` is the same file for FR-ANL-06 and this follows it.
//
// **EVERY TENANT PER INVOCATION, WHERE ITS SIBLING TAKES ONE.** The difference is the
// instrument: FR-ANL-06's operational side is a row per tenant-period and can be asked for
// one, and DR-17's is a listing of a bucket, which arrives whole. `--environment` filters
// the report afterwards; it does not narrow what was read, and the summary says so.
//
// EXIT NON-ZERO ON ANY UNEXPLAINED DRIFT. ADR-28 records that as the whole of what "raises
// an alert" can mean here — no alerting integration, and **no runner of any kind for a
// recurring job**: zero `schedule:` triggers in `ci.yml`, and this script joins
// `reconcile-usage.mjs` as the second weekly job nothing runs weekly.
import { createDb, createPool, DEFAULT_DATABASE_URL } from "../services/api/dist/db/client.js";
import { storeConfig } from "../services/api/dist/media/store.js";
import { createAnalyticalStore } from "../services/api/dist/metering/clickhouse.js";
import {
  assertEnvironmentId,
  exitCodeFor,
  reconcileStorage,
} from "../services/api/dist/metering/storage-reconcile.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return value;
}

// REFUSED AT PARSE TIME SO THE MESSAGE CAN NAME THE FLAG, and again inside the module that
// builds the statement. One rule, two call sites, one implementation — `reconcile-usage.mjs`
// makes the same argument about the same pair of guards.
const only = process.argv.includes("--environment")
  ? assertEnvironmentId(arg("environment"))
  : undefined;

const database = arg("database", process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
process.env.DATABASE_URL = database;

const db = createDb(createPool());
const store = createAnalyticalStore();
const config = storeConfig();

// WHICH DATABASE AND WHICH BUCKET THIS REPORT IS ABOUT. A figure copied out of this output
// is unattributable without both, and this comparison has three sides rather than two.
// No credential is printed.
console.log(
  `reconcile-storage: ${config.bucket} at ${config.internalEndpoint} against ` +
    `${database.replace(/\/\/[^@/]*@/, "//")}`,
);

const report = await reconcileStorage(db, store, config);

// THE COVERAGE LINE GOES FIRST, AND IT IS FR-007. An instrument that reports how many
// problems it found has said nothing about how much it looked at — this project's
// most-repeated failure, and the reason five gate scripts print a counted line.
console.log(
  `inventory: ${report.inventory.objects} objects, ${report.inventory.bytes} bytes, ` +
    `${report.inventory.pages} page(s)${report.inventory.truncated ? " — TRUNCATED" : ""}`,
);
// **NOT "N OF M".** The first version printed `1855 of 1678 holding media` — a containment
// claim that is false, because the union takes tenants the operational side has never heard
// of: a rollup fed by a stream carries no foreign key, and a bucket prefix outlives the rows
// that made it. The sides are printed beside the union instead, so the reader can see which
// one is carrying the population rather than being told a ratio that does not divide.
const { rollup, bucket, reservations, withMedia } = report.sides;
console.log(
  `tenants examined: ${report.tenantsExamined} — rollup ${rollup}, bucket ${bucket}, ` +
    `outstanding reservations ${reservations}, holding media in Postgres ${withMedia}`,
);
console.log(
  `keys belonging to no tenant: ${report.unattributable.keys}, ${report.unattributable.bytes} bytes`,
);

// A TRUNCATED LISTING IS A REFUSAL, NOT A FOOTNOTE. Every verdict below it would be about
// a bucket the job did not finish reading, which is 4.13's one-page sweep inside the
// instrument written to catch it.
if (report.inventory.truncated) {
  console.error("reconcile-storage: the listing did not finish — no verdict is comparable");
  await db.$client.end?.();
  process.exit(2);
}

const counts = new Map();
for (const r of report.rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
console.log(
  "verdicts: " +
    [...counts].sort().map(([v, n]) => `${v} ${n}`).join(", "),
);

const shown = only === undefined ? report.rows : report.rows.filter((r) => r.environmentId === only);
if (only !== undefined && shown.length === 0) {
  console.log(`(${only} appears on none of the three sides)`);
}
for (const r of shown) {
  // Only the rows a reader has to act on, unless one tenant was asked for by name.
  if (only === undefined && r.verdict !== "meter-high" && r.verdict !== "meter-low") continue;
  const drift = r.drift === null ? "     —" : `${(r.drift * 100).toFixed(4)}%`;
  const m = r.metered === null ? "absent" : String(r.metered);
  const s = r.inStore === null ? "absent" : String(r.inStore);
  console.log(
    `${r.environmentId}  metered ${m.padStart(12)}  store ${s.padStart(12)}` +
      `  reserved ${String(r.reserved).padStart(12)}  ${drift.padStart(10)}  ${r.verdict}`,
  );
}

await db.$client.end?.();
// THE VERDICT-TO-EXIT-CODE RULE IS NOT DECIDED HERE, for the reason its sibling records:
// it was, in one expression no lane ever ran. `exitCodeFor` is the same rule where a test
// can reach it. **The whole report, never the filtered view** — a breach elsewhere is still
// a breach, and an exit code that depended on which tenant was asked about would be a flag
// that turns a failure green.
process.exit(exitCodeFor(report.rows));
