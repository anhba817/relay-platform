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
        // 89.51%. These per-file numbers are therefore a RATCHET pinned at
        // today's measurement, not the bar: they stop the figure sliding
        // backwards while the gap is closed, and they are deliberately not the
        // 100% the constitution asks for, because a threshold nothing can pass
        // makes CI permanently red and teaches everyone to ignore it.
        //
        // The gap is recorded in specs/024-coverage-and-ci/notes.md with the
        // uncovered branches named. Raising these to 100 is the work; this
        // feature is the instrument that made the number sayable at all.
        //
        // CHAPTER 3.5 RAISED THESE, and only after earning it. The webhook work
        // added six operations to this file and the ratchet immediately went
        // red — branches fell from 85.91% to 78.22%, because `deliveryMaterial`
        // and `pendingDeliveryDepth` were called only by the dispatcher, whose
        // suite runs the api as a CHILD PROCESS whose coverage is not
        // attributable. The instrument was right and the code was not tested.
        // Lowering the numbers to match would have been the whole point of a
        // ratchet, thrown away; the tests in `webhooks/deliveries.itest.ts` were
        // written instead, and these are the measurement that followed.
        //
        // CHAPTER 3.6 RAISED THEM AGAIN, and the ratchet earned its keep twice on
        // the way. Measured mid-chapter with the failure run written and its tests
        // not yet, this file read 96.46 statements and 88.80 branches — below both
        // thresholds, which is the instrument saying "you added five operations and
        // tested none of them" in the only language it has. The tests were written;
        // it now reads 97.29 / 90.56 / 100 / 99.14. These numbers are that
        // measurement, not a target negotiated down to meet it.
        "services/api/src/db/repository.ts": {
          branches: 90,
          functions: 100,
          lines: 99,
          statements: 97,
        },

        // The dispatcher's two decision-bearing files (chapter 3.5). `expand.ts`
        // decides whether a redelivered event produces a second set of webhooks
        // — constitution VI names idempotency explicitly — and `deliver.ts`
        // holds the post-then-report ordering that chooses a duplicate over a
        // silent loss. Pinned here because they measured 0% and 87.5% when the
        // service arrived, which is exactly what research R12 warned a new
        // deployable would do to a green instrument.
        "services/dispatcher/src/expand.ts": {
          branches: 92,
          functions: 100,
          lines: 100,
          statements: 92,
        },
        "services/dispatcher/src/deliver.ts": {
          branches: 90,
          functions: 100,
          lines: 100,
          statements: 100,
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

        // Chapter 3.6's two new files, pinned at 100 on every metric because both
        // reached it and neither has an excuse not to.
        //
        // `disable.ts` is here because constitution VI NAMES this case: it is the
        // predicate the at-most-once disablement rests on, so it is idempotency
        // logic, and NFR-MNT-02 asks for 100% branch coverage of that. It is also
        // pure — no database, no clock, no broker — which is precisely why it was
        // separated from both triggers that call it. A file with nothing to mock has
        // no reason to be partially tested.
        //
        // `analytics.ts` is here for a different reason: everything it does is
        // decide what NOT to put on a stream. Its allow-list is the mechanism
        // standing between a customer's payload and seven days of retention
        // (FR-004, SC-006), and its `catch` is what stops an analytics outage
        // becoming a delivery outage (contract invariant 4). Both are branches, and
        // an unmeasured branch here fails silently in the direction nobody checks.
        "services/api/src/webhooks/disable.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/webhooks/analytics.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
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
