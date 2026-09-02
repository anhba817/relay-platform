import { defineConfig } from "vitest/config";

// The guard's own lane. `globalSetup` installs the function and the triggers, the
// same file every other lane uses; there is deliberately NO `setupFiles`, because
// this suite manages its own connections — one carrying the exemption and one
// not — and a setup file that rewrote DATABASE_URL would remove the distinction
// the tests are about.
//
// AND NO `fileParallelism: false` — WHICH IS NOW TRUE OF EVERY LANE BUT COVERAGE, AND
// WAS WRITTEN HERE AS THE EXCEPTION. The api and gateway lanes set it because several
// suites call `migrate(pool)` concurrently and race on `pg_type_typname_nsp_index`. That
// race is one run wide — the first after a schema change — and serialising every file for
// ever to cover it cost 175 seconds a battery; both lanes dropped it in this chapter, once
// the six places that actually needed the files kept apart were fixed where they live.
//
// Here it was never needed for either reason: `globalSetup` migrates once and there is one
// suite. A setting that changes nothing is worth leaving out — it reads as a requirement to
// whoever copies this file next, which is exactly how it spread to two lanes that then kept
// it for six chapters after the reason had been fixed.
export default defineConfig({
  test: {
    globalSetup: ["src/global-setup.ts"],
    include: ["src/**/*.itest.ts"],
    hookTimeout: 60_000,
  },
});
