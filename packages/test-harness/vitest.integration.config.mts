import { defineConfig } from "vitest/config";

// The guard's own lane. `globalSetup` installs the function and the triggers, the
// same file every other lane uses; there is deliberately NO `setupFiles`, because
// this suite manages its own connections — one carrying the exemption and one
// not — and a setup file that rewrote DATABASE_URL would remove the distinction
// the tests are about.
export default defineConfig({
  test: {
    globalSetup: ["src/global-setup.ts"],
    include: ["src/**/*.itest.ts"],
    hookTimeout: 60_000,
  },
});
