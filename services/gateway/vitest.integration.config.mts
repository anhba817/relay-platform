import { defineConfig } from "vitest/config";

// The gateway's integration lane (chapter 2.6). Same convention 2.1
// established for the api: *.itest.ts is invisible to the Docker-free unit
// include, and this config is what `pnpm --filter @relay/gateway
// test:integration` runs against the compose Redis.
export default defineConfig({
  test: {
    // Feature 030: the global-operation guard. `globalSetup` migrates and
    // then installs the trigger once per lane; `setupFiles` sets the
    // exemption for files on the harness's list and, where the lane carries
    // bait, plants it per file. This lane gets exemption
    // handling and NO bait: it holds no reader-shape fault, and planting
    // would change its workload for no return (FR-022).
    globalSetup: ["../../packages/test-harness/src/global-setup.ts"],
    setupFiles: ["../../packages/test-harness/src/setup.ts"],
    include: ["src/**/*.itest.ts"],
    // FILES IN PARALLEL AGAIN, AND EIGHT PLACES ARE WHY IT COULD NOT BE.
    //
    // This lane ran one file at a time from the outbox chapter, for a real reason: a
    // PENDING migration lets two suites issue `CREATE TYPE` against one schema, and
    // Postgres answers `duplicate key value violates unique constraint
    // "pg_type_typname_nsp_index"` — an error about its own catalogue that reads like a
    // driver fault. That window closed in the instruments chapter, when `globalSetup`
    // began migrating once before any file starts; the setting outlived it by eight
    // chapters. The probe is a fresh database with every file racing, and it passes.
    //
    // What actually kept the files apart was EIGHT places scoped wider than their own
    // subject, spread across eight chapters. The connection-cap chapter has them in a
    // table with what each one really read. Three were known and carried in; five came
    // from running the lane without the setting and reading what fell over, one at a
    // time, over six runs. **Three of the five are not assertions at all.**
    //
    // AND THE WORKER COUNT IS MEASURED, NOT INHERITED. Vitest defaults to roughly one
    // worker per core, which here is nine NestJS applications against one Postgres:
    //
    //   maxWorkers      2      3      4      6
    //   gateway lane  69s    46s    35s    35s
    //   peak used   4313M  4623M  4717M  5064M
    //
    // **The knee is at four here and at TWO in the api lane**, whose curve is flat from
    // two workers on. These suites each drive a child api of their own, so they overlap
    // further before they start queueing on the same database — **the right number is
    // per-lane and measured, and a default is neither.** Above the knee it stops being
    // free: six workers is no faster than four, and `typing.itest.ts` starts missing a
    // presence frame it waits for.
    maxWorkers: 4,
    //
    // Each of the eight is fixed where it lives. The migration race is left to the one
    // run it can happen on.
  },
});
