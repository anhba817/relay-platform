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
    include: ["src/**/*.itest.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
