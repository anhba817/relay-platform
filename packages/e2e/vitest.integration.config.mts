import { defineConfig } from "vitest/config";

// The system lane (chapter 2.8). Same `*.itest.ts` convention 2.1
// established, with one difference that matters: this package has no `test`
// script at all, so the Docker-free gate never looks here. A journey suite
// that boots two gateways and an api has no business slowing down the loop
// a reader runs on every save.
//
// The whole suite is one journey, and it boots real processes — so it gets
// a real timeout, and it does not run its files in parallel.
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
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
