import { defineConfig } from "vitest/config";

// The integration lane (chapter 2.1). *.itest.ts files are invisible to the
// unit lane's include on purpose: `pnpm test` stays Docker-free, and this
// config is what `pnpm --filter @relay/api test:integration` runs against
// the compose Postgres. (.mts because this package compiles to CommonJS —
// a .ts config would be loaded as CJS, which vitest refuses.)
export default defineConfig({
  test: {
    // Feature 030: the global-operation guard. `globalSetup` migrates and
    // then installs the trigger once per lane; `setupFiles` sets the
    // exemption for files on the harness's list and, where the lane carries
    // bait, plants it per file.
    globalSetup: ["../../packages/test-harness/src/global-setup.ts"],
    setupFiles: ["../../packages/test-harness/src/setup.ts"],
    env: { RELAY_HARNESS_BAIT: "on" },
    include: ["src/**/*.itest.ts"],
  },
});
