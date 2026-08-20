import { defineConfig } from "vitest/config";

// The dispatcher's integration lane (chapter 3.5). Same convention 2.1
// established for the api and 2.6 for the gateway: *.itest.ts is invisible to
// the Docker-free unit include, so `pnpm test` stays runnable with no stores.
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
    // A delivery to a hostile endpoint spends real time on timeouts and the
    // widening schedule. The default 5 s would fail the suite for being honest.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
