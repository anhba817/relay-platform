#!/usr/bin/env node
// FR-ANL-06's daily job, as a thin caller. The comparison lives in
// `services/api/src/metering/reconcile.ts`; this constructs the two handles and prints.
//
// ONE TENANT PER INVOCATION, because the function takes one. A sweep is a loop here, and it
// would have to know two things a single call cannot meet: the analytical store holds
// environment ids that exist in no Postgres row (four today, all test fixtures, because a
// stream carries no foreign key), and `usage_periods` holds a `1999-01-01` period belonging
// to `__sentinel__` applications planted by the lane's own guard.
//
// EXIT NON-ZERO ON ANY BREACH. That is the whole of what "raises an alert" can mean here:
// this platform has no alerting integration, and the one notification path that exists is
// `quotas/quota-email.ts`, whose failure mode is already visible in the lane as
// `quotas.unaddressable: no member has an email address`. A notification with no recipient is
// not an alert, and an exit code is not one either — the chapter says what a real one costs.
import { createDb, createPool, DEFAULT_DATABASE_URL } from "../services/api/dist/db/client.js";
import { createAnalyticalStore } from "../services/api/dist/metering/clickhouse.js";
import {
  assertEnvironmentId,
  assertPeriod,
  exitCodeFor,
  reconcile,
} from "../services/api/dist/metering/reconcile.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return value;
}

// BOTH VALUES ARE REFUSED HERE AND AGAIN INSIDE `reconcile`, AND THAT IS ONE RULE RATHER THAN
// TWO. `assertEnvironmentId` and `assertPeriod` are exported from the module that builds the
// statements; calling them at parse time is what lets the refusal name the flag and happen
// before a connection is opened. The guard that matters is the one inside the function, which
// no caller can skip.
const environmentId = assertEnvironmentId(arg("environment"));
const period = assertPeriod(arg("period"));

// `--database`, SO THE JOB CAN BE POINTED AT A CORPUS (chapter 4.9, FR-006).
//
// Without it the reconciler reads whatever `DATABASE_URL` says, which is the lane — where no
// tenant has both sides of the comparison and the largest tenant-period holds 1,017 messages,
// a volume at which the smallest expressible drift is twice the 0.1% bound. The measurement
// needs a database built for it, and this is the address.
//
// IT SETS THE ENVIRONMENT VARIABLE RATHER THAN TAKING A PARAMETER, and that is the shape
// `createPool()` leaves available: it takes no arguments and reads `process.env.DATABASE_URL`
// when it is called, and `pg` itself does not resolve from `scripts/` — it is a dependency of
// `services/api`, not of the root, which is the trap `corpus.mjs` already records at its
// refusal path. One mutation, before the pool exists, in a process that does nothing else.
//
// **THERE IS NO `--analytics-database`, AND THE FIRST DESIGN HAD ONE.** `DB_ANALYTICS` is a
// constant inside `reconcile.ts` rather than a parameter, and `analytics/apply.mjs` hardcodes
// the same name — so nothing in this repository can build a second analytical database for a
// flag to point at. The corpus's rows live in `relay_analytics` beside the lane's and are
// separated by environment id, exactly as every tenant's are.
const database = arg("database", process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
process.env.DATABASE_URL = database;

const db = createDb(createPool());
const store = createAnalyticalStore();

// WHICH DATABASE THIS REPORT IS ABOUT. A figure copied out of this output into a published
// document is unattributable without it, and the whole point of the flag above is that the
// answer is no longer "the lane, obviously". The password is not printed.
console.log(
  `reconcile: ${environmentId} ${period} against ${database.replace(/\/\/[^@/]*@/, "//")}`,
);

const rows = await reconcile(db, store, { environmentId, period });

for (const r of rows) {
  const pct = r.differencePct === null ? "     —" : `${(r.differencePct * 100).toFixed(4)}%`;
  const a = r.analytical === null ? "absent" : String(r.analytical);
  const o = r.operational === null ? "absent" : String(r.operational);
  console.log(
    `${r.quantity.padEnd(18)} analytical ${a.padStart(10)}  operational ${o.padStart(10)}` +
      `  ${pct.padStart(9)}  ${r.verdict}` +
      (r.operationalSource ? `  (${r.operationalSource})` : ""),
  );
}

const breached = rows.filter((r) => r.verdict === "breach");
if (breached.length > 0) {
  console.error(
    `reconcile: ${breached.length} breach(es) for ${environmentId} in ${period}: ` +
      breached.map((r) => r.quantity).join(", "),
  );
}
await db.$client.end?.();
// THE VERDICT-TO-EXIT-CODE RULE IS NOT DECIDED HERE. It was, in one expression this lane never
// ran; `exitCodeFor` is the same rule where a test can reach it.
process.exit(exitCodeFor(rows));
