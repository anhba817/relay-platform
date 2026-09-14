import { defineConfig } from "vitest/config";

// The integration lane: real NATS, real ClickHouse. `*.itest.ts` only, and serial —
// the redelivery test owns a stream and a table window, and a neighbour running beside
// it would be somebody else's rows in this one's count.
export default defineConfig({
  test: {
    include: ["src/**/*.itest.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
