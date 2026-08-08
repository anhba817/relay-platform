import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

// Coverage, across BOTH lanes (feature 024).
//
// This config exists because constitution VI's bar cannot be measured one
// package at a time. The code it names — message ordering, idempotency, tenant
// isolation — lives in the api's repository layer, and most of it is reached
// only by integration tests. A unit-only coverage run would report a
// comfortable number about the wrong thing, which is worse than no number.
//
// So the include list is both `*.test.ts` and `*.itest.ts`, and running this
// needs the compose stores up. That is the honest cost of measuring the thing
// the constitution actually asks about.
//
// The SWC plugin is here for the same reason `services/api/vitest.config.mts`
// has it: esbuild strips decorators without emitting metadata, and Nest's DI
// would silently resolve nothing. It is harmless for the packages that use no
// decorators.
export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "services/*/src/**/*.test.ts",
      "packages/*/src/**/*.itest.ts",
      "services/*/src/**/*.itest.ts",
    ],
    // The e2e journey spawns real services and is excluded on purpose: it
    // measures the system, not any file's branches, and its child processes'
    // coverage is not attributable here anyway.
    exclude: ["**/node_modules/**", "packages/e2e/**"],
    // Suites in one process would share a database in ways their authors did
    // not design for — 3.3's outbox suite learned that the hard way.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.ts", "services/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.itest.ts",
        "**/dist/**",
        "packages/e2e/**",
        // Entry points and framework wiring: reached by running the service,
        // not by asserting on it. Counting them measures how much of `main.ts`
        // a test happened to touch, which is not what "business logic" means.
        "**/main.ts",
        "**/*.module.ts",
      ],
      thresholds: {
        // Constitution VI, first clause: 70% of business logic. Set to what the
        // constitution says, not to what the code achieves — a threshold tuned
        // down to pass measures nothing. Currently met with room to spare
        // (86.55% statements, 78.07% branches at the time of writing).
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 70,

        // Constitution VI, second clause: ordering, idempotency and tenant
        // isolation MUST have 100% BRANCH coverage (NFR-MNT-02).
        //
        // They do not. `repository.ts` — which holds all three — measures
        // 85.91%. These per-file numbers are therefore a RATCHET pinned at
        // today's measurement, not the bar: they stop the figure sliding
        // backwards while the gap is closed, and they are deliberately not the
        // 100% the constitution asks for, because a threshold nothing can pass
        // makes CI permanently red and teaches everyone to ignore it.
        //
        // The gap is recorded in specs/024-coverage-and-ci/notes.md with the
        // uncovered branches named. Raising these to 100 is the work; this
        // feature is the instrument that made the number sayable at all.
        "services/api/src/db/repository.ts": {
          branches: 85,
          functions: 100,
          lines: 98,
          statements: 95,
        },
        "services/gateway/src/resume.ts": {
          branches: 93,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/auth/user-token.ts": {
          branches: 96,
          functions: 100,
          lines: 100,
          statements: 96,
        },
      },
    },
  },
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: { transform: { legacyDecorator: true, decoratorMetadata: true } },
    }),
  ],
});
