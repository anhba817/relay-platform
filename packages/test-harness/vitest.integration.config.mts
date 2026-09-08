import { defineConfig } from "vitest/config";

// The guard's own lane. `globalSetup` installs the function and the triggers, the
// same file every other lane uses; there is deliberately NO `setupFiles`, because
// this suite manages its own connections — one carrying the exemption and one
// not — and a setup file that rewrote DATABASE_URL would remove the distinction
// the tests are about.
//
// AND NO `fileParallelism: false`, unlike the api and gateway lanes. Those need it
// because several suites call `migrate(pool)` concurrently and race on
// `pg_type_typname_nsp_index`; here `globalSetup` migrates once and there is one
// suite. A setting that changes nothing is worth leaving out — it reads as a
// requirement to whoever copies this file next.
export default defineConfig({
  test: {
    globalSetup: ["src/global-setup.ts"],
    include: ["src/**/*.itest.ts"],
    hookTimeout: 60_000,
  },
});
