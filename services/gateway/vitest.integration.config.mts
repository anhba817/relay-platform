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
    // ONE FILE AT A TIME, BECAUSE THEY SHARE ONE DATABASE.
    //
    // Every suite here runs migrations before it starts. Vitest runs FILES in parallel
    // by default, so several of them issue `CREATE TYPE` against the same schema at the
    // same moment and Postgres answers `duplicate key value violates unique constraint
    // "pg_type_typname_nsp_index"` — an error about its own catalogue, which reads like
    // a driver fault and is not one.
    //
    // It only bites when a migration is PENDING. With the schema already applied every
    // suite finds nothing to do and the race has no window, which is why serialising the
    // turbo tasks was enough until this chapter added a table.
    fileParallelism: false,
  },
});
