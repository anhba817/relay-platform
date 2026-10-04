import { RECORDS_NOTHING } from "../audit/actor";
import { createDb, createPool } from "../db/client";
import { environmentsWithPolicy } from "../db/retention-reads";
import { Repository } from "../db/repository";

// CHAPTER 4.20 — FR-MOD-06's retention job, and the word `job` is the part this file
// cannot supply.
//
// NOTHING RUNS THIS. There is no scheduler anywhere in this platform — ADR-28 declined
// to build one for FR-ANL-06's daily reconciliation, DR-17 is bounded by the same
// absence, and FR-MOD-03's retention year is the third clause to say so. This is the
// fourth. So the sweep is a command an operator invokes, and the chapter publishes that
// rather than implying a timer:
//
//     pnpm --filter @relay/api exec node dist/retention/sweep.js [--dry-run]
//
// IT PROMISES THAT WHEN IT RUNS, every message past its environment's policy is
// destroyed. It promises nothing about when it runs, which is why no surface publishes
// an `expires_at` a compliance team could read as a deadline.

/** How many messages one statement destroys. Pages are a bound on the transaction, not
 * on the run: the sweep keeps reading until an environment is exhausted. */
const PAGE = 500;

export interface SweepCounts {
  environmentId: string;
  messagesDestroyed: number;
  pages: number;
}

export interface SweepOptions {
  dryRun?: boolean;
  /** One environment instead of all of them, for an operator investigating one tenant.
   *
   * `| undefined` EXPLICITLY, because this workspace compiles with
   * `exactOptionalPropertyTypes`: under it an optional property and a property that may
   * hold `undefined` are different types, and the CLI below builds this object from an
   * `argv` lookup that yields one or the other. */
  environmentId?: string | undefined;
}

/** Destroy every expired message in every environment that has a policy.
 *
 * Called by `main()` below, which is this file's CLI entry, and by
 * `retention.itest.ts`. Nothing in the running platform calls it: see the header.
 *
 * **THE PREDICATE IS SELF-CLEARING, WHICH IS WHY FR-008 NEEDS NO LEDGER.** A destroyed
 * message cannot match the next pass, so a re-run completes the work an interrupted run
 * left and the second of two identical runs reports zero. That is constitution IV's
 * single-writer requirement satisfied by the shape of the statement rather than by a
 * lease, a heartbeat or a reaper — chapter 4.13's `UPDATE … WHERE state = 'pending'`
 * made the same argument.
 *
 * **IT LOOPS TO EXHAUSTION RATHER THAN READING ONE PAGE.** Chapter 4.13's sweep read a
 * single page and its head never moved, so an object nobody uploaded to stayed
 * `pending` for ever. A bound on the run would be defensible if something re-ran it;
 * nothing does. */
export async function sweepRetention(
  db: ReturnType<typeof createDb>,
  now: Date,
  options: SweepOptions = {},
): Promise<SweepCounts[]> {
  const policies = (await environmentsWithPolicy(db)).filter(
    (p) => options.environmentId === undefined || p.id === options.environmentId,
  );

  const counts: SweepCounts[] = [];
  for (const policy of policies) {
    // ONE REPOSITORY PER ENVIRONMENT, which is what makes constitution I's constructor
    // requirement a fact about this loop rather than an exception to it. The bound is
    // computed here, in the application, so it reaches the statement as a constant the
    // planner can push into `messages_channel_created`'s Index Cond — as a join filter
    // across every environment it lands in a `Join Filter` instead and discards every
    // message in the policied one.
    // `RECORDS_NOTHING` AND NOT AN OMITTED ARGUMENT. `repository.itest.ts` walks the
    // source of every construction site and requires three arguments — an optional
    // parameter is a check the compiler stopped doing, so a test reads the source
    // instead (chapter 4.18). It fired on this line, correctly.
    //
    // AND NOTHING IS THE RIGHT ANSWER HERE, not a placeholder for one. FR-MOD-03's
    // population is *moderation actions*, which are things a credential did; this sweep
    // runs from a command line with no credential in the picture at all, and
    // `moderation-routes.ts` classifies the policy route that armed it as
    // `not-moderation` for the same reason. An invented actor would put a row in the
    // audit log naming somebody who deleted nothing.
    const repo = new Repository(db, policy.id, RECORDS_NOTHING);
    const olderThan = new Date(now.getTime() - policy.retentionDays * 86_400_000);

    let destroyed = 0;
    let pages = 0;
    let after: { channelId: string; createdAt: Date } | undefined;
    for (;;) {
      const page = await repo.expiredMessageIds(olderThan, PAGE, after);
      if (page.length === 0) break;
      pages += 1;
      if (options.dryRun) {
        destroyed += page.length;
      } else {
        destroyed += await repo.destroyMessages(page.map((row) => row.id));
      }
      // KEYSET, NOT OFFSET. On a dry run nothing is deleted, so the cursor is the only
      // thing that advances — without it the same page returns for ever.
      const last = page[page.length - 1]!;
      after = { channelId: last.channelId, createdAt: last.createdAt };
      if (page.length < PAGE) break;
    }
    counts.push({ environmentId: policy.id, messagesDestroyed: destroyed, pages });
  }
  return counts;
}

/** THE COUNTED LINE IS THE OUTPUT, NOT THE EXIT CODE.
 *
 * 055-4: five of seven gate scripts in this workspace exit 0 when their corpus is
 * absent, and the rule that entry produced is to assert the line. A sweep that found no
 * environment with a policy and a sweep that found nothing expired both exit 0, so they
 * must not print the same thing. */
export function report(counts: SweepCounts[], dryRun: boolean): string {
  const verb = dryRun ? "would destroy" : "destroyed";
  if (counts.length === 0) {
    return "retention: no environment has a policy — nothing to sweep";
  }
  const lines = counts.map(
    (c) =>
      `retention: ${c.environmentId} ${verb} ${c.messagesDestroyed} message(s) over ${c.pages} page(s)`,
  );
  const total = counts.reduce((sum, c) => sum + c.messagesDestroyed, 0);
  lines.push(
    `retention: ${counts.length} environment(s) with a policy, ${total} message(s) ${verb} in total`,
  );
  return lines.join("\n");
}

// This package compiles to CommonJS (ADR-15's dialect), so the "am I the entry file?"
// check is require.main — import.meta does not exist here. `migrate.ts` says the same.
if (require.main === module) {
  void (async () => {
    const dryRun = process.argv.includes("--dry-run");
    const at = process.argv.indexOf("--environment");
    const environmentId = at === -1 ? undefined : process.argv[at + 1];

    const pool = createPool();
    const db = createDb(pool);
    try {
      const counts = await sweepRetention(db, new Date(), { dryRun, environmentId });
      console.log(report(counts, dryRun));
    } finally {
      await pool.end();
    }
  })();
}
