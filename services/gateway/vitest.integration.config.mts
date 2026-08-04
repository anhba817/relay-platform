import { defineConfig } from "vitest/config";

// The gateway's integration lane (chapter 2.6). Same convention 2.1
// established for the api: *.itest.ts is invisible to the Docker-free unit
// include, and this config is what `pnpm --filter @relay/gateway
// test:integration` runs against the compose Redis.
export default defineConfig({
  test: {
    include: ["src/**/*.itest.ts"],
  },
});
