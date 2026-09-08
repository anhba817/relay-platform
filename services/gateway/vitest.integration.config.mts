import { defineConfig } from "vitest/config";

// The gateway's integration lane (chapter 2.6). Same convention 2.1
// established for the api: *.itest.ts is invisible to the Docker-free unit
// include, and this config is what `pnpm --filter @relay/gateway
// test:integration` runs against the compose Redis.
export default defineConfig({
  test: {
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
