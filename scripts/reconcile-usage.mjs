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
import { createDb, createPool } from "../services/api/dist/db/client.js";
import { createAnalyticalStore } from "../services/api/dist/metering/clickhouse.js";
import { exitCodeFor, reconcile } from "../services/api/dist/metering/reconcile.js";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    throw new Error(`--${name} is required`);
  }
  return process.argv[i + 1];
}

const environmentId = arg("environment");
const period = arg("period");

const db = createDb(createPool());
const store = createAnalyticalStore();

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
