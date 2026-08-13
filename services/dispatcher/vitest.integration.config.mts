import { defineConfig } from "vitest/config";

// The dispatcher's integration lane (chapter 3.5). Same convention 2.1
// established for the api and 2.6 for the gateway: *.itest.ts is invisible to
// the Docker-free unit include, so `pnpm test` stays runnable with no stores.
export default defineConfig({
  test: {
    include: ["src/**/*.itest.ts"],
    // A delivery to a hostile endpoint spends real time on timeouts and the
    // widening schedule. The default 5 s would fail the suite for being honest.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
