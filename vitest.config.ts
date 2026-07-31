import { defineConfig } from "vitest/config";

// One test runner for the whole workspace (ADR-01's consequence made literal).
export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "services/**/src/**/*.test.ts"],
  },
});
