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
    // Feature 030: the global-operation guard. `globalSetup` migrates and
    // then installs the trigger once per lane; `setupFiles` sets the
    // exemption for files on the harness's list and, where the lane carries
    // bait, plants it per file. This lane gets exemption
    // handling and NO bait: it holds no reader-shape fault, and planting
    // would change its workload for no return (feature 030).
    globalSetup: ["./packages/test-harness/src/global-setup.ts"],
    // FEATURE 030, MEASURED: nine suites in this lane import `AppModule`, and none
    // of them set a relay flag. Each relay defaults to on when its flag is unset
    // (`process.env.RELAY_OUTBOX_RELAY ?? "on"`), so those nine booted four
    // background loops that sweep the whole database while every other suite's
    // fixtures sit in it. Research R13 recorded the exposure as nil on the strength
    // of the four suites that spawn an api CHILD and set the flags in the child's
    // env; it did not look at the suites that boot the app in process.
    //
    // A relay catches and logs its own errors, so the guard's refusal inside one is
    // a log line and a green lane. Setting the flags here makes the quiet database
    // a property of the lane rather than a convention nobody applied.
    env: {
      RELAY_OUTBOX_RELAY: "off",
      RELAY_DELIVERY_RELAY: "off",
      RELAY_NOTIFICATION_RELAY: "off",
      RELAY_EVENT_CONSUMER: "off",
      // Chapter 3.10's relay, the fourth. Same reason as the other three.
      RELAY_QUOTA_RELAY: "off",
    },
    setupFiles: ["./packages/test-harness/src/setup.ts"],
    include: [
      "packages/*/src/**/*.test.ts",
      "services/*/src/**/*.test.ts",
      "packages/*/src/**/*.itest.ts",
      "services/*/src/**/*.itest.ts",
    ],
    // The e2e journey spawns real services and is excluded on purpose: it
    // measures the system, not any file's branches, and its child processes'
    // coverage is not attributable here anyway.
    //
    // AND `packages/outsider` FOR A DIFFERENT REASON, added in chapter 3.15's Phase 1.
    // That suite integrates against a platform it does not start: without
    // RELAY_API_URL, RELAY_WS_URL and RELAY_DEMO_CREDENTIAL it throws on purpose and
    // prints the five commands that would satisfy it. `pnpm coverage` sets none of
    // them, so it failed every coverage run — 8 tests skipped, one failed suite.
    //
    // Chapter 3.12 split the lanes so `pnpm test:integration` is
    // `turbo run test:integration --filter=!@relay/outsider`, and the exclusion went
    // into the script and NOT into this config. One lane learned it and the other did
    // not. `pnpm test:outsider` is the way in, and the CI `outsider` job is where it
    // runs with its stack.
    exclude: [
      "**/node_modules/**",
      "packages/e2e/**",
      "packages/outsider/**",
    ],
    // Suites in one process would share a database in ways their authors did
    // not design for — 3.3's outbox suite learned that the hard way.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      // `json` joins the other two for chapter 3.13's FR-040, which asks for every
      // uncovered branch to be NAMED and not merely counted. `json-summary` carries
      // totals and percentages; the per-branch locations are only in `coverage-final.json`.
      // Found by trying to list the 25 uncovered arms in `repository.ts` and getting a
      // file that does not contain them. `coverage/` is gitignored, so this commits nothing.
      reporter: ["text", "json-summary", "json"],
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
        // The lane's own scaffolding (feature 030). Same argument one step out:
        // counting how much of the harness a test touched measures the harness,
        // not the product.
        "packages/test-harness/src/**",
      ],
      thresholds: {
        // Constitution VI, first clause: 70% of business logic. Set to what the
        // constitution says, not to what the code achieves — a threshold tuned
        // down to pass measures nothing. Currently met with room to spare
        // (89.50% statements, 82.73% branches after chapter 3.8, up from 86.55%
        // and 78.07%). Ten new files, eight of them small and heavily branched,
        // moved both figures up — which is not the usual direction for a chapter
        // that adds code, and worth naming for that reason.
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
        // CHAPTER 3.12 DID NOT RAISE THIS, and the number says why. The chapter
        // added six operations to this file — idempotent creation for channels and
        // users, a three-outcome `addMember`, two scoped counts — and branches
        // measured 90.43% mid-phase, DOWN from T007's 90.60% while still above the
        // pinned 90. Three new uncovered arms, all of them the same kind:
        //
        //   - `addMember`'s `(inserted.rowCount ?? 0)` — REMOVED rather than named.
        //     `rowCount` is typed `number | null` and is never null for an INSERT,
        //     so the `??` was an arm nothing could take, bought for nothing in the
        //     one file constitution VI asks 100% of. `RETURNING` and `.rows.length`
        //     replaced it.
        //   - `createChannel`'s and `createUser`'s "could not be created or read"
        //     throws. Both are the loser of an `ON CONFLICT` race finding no row,
        //     which means the winner's row was deleted between two statements in
        //     the same call. Nothing in the api deletes from either table, so
        //     reaching these means constructing a state the layer exists to make
        //     unconstructable — the same class T007's list already named for lines
        //     151 and 3139.
        //
        // It now reads 90.71%, above where the chapter found it and below 91, so
        // the pin stays at 90 rather than moving to a number the next chapter
        // would have to earn back.
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
        // CHAPTER 3.7 RAISED THIS, 93 -> 95. The chapter added two pure functions
        // to this file — the live-path suppression predicate and the scoping that
        // bounds the marks — and both are fully covered.
        //
        // Not 100, and the missing branch is named rather than chased: it is
        // `if (timer)` in chapter 2.7's `withDeadline`, whose falsy arm cannot be
        // reached because a Promise executor runs synchronously and always assigns
        // the timer before the `finally` can see it. Pinning 100 here would pin a
        // number the file cannot reach without deleting a defensive check that
        // costs nothing.
        "services/gateway/src/resume.ts": {
          branches: 95,
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
        // ── CHAPTER 3.12'S NEW FILES, PINNED DELIBERATELY ──────────────────
        //
        // T079 asked for an explicit decision either way, and the answer is: pin
        // the ones that decide something, at what they measure. All of these sit
        // inside the coverage `include` glob, so an unpinned file here is bounded
        // by nothing but the aggregate 70 — chapter 3.11's T033c made the same
        // call for the same reason, and its comment is the one to read: an
        // unpinned file is a figure that can slide.
        //
        // `catalogue.ts` matters most of the four. It lands in
        // `services/api/src/db/`, the one directory that already carries a
        // per-file ratchet and the directory constitution VI's 100%-branch clause
        // is about. It reaches 100 on every metric — but only after the
        // classification was separated from the query, because the arm that
        // returns `null` cannot execute against a database that has no
        // unclassified table, which is the state the check exists to keep. The
        // separation is the finding; the number is what it bought.
        "services/api/src/db/catalogue.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },

        // The gauntlet's own instruments. Test infrastructure that the include
        // glob cannot tell from product code — and rather than adding an exclude
        // entry to hide them, they are pinned, because Phase 7's whole argument
        // applies one layer down: an instrument that has never produced output has
        // never had its output checked. Both reached 100 only after the arms a
        // PASSING suite cannot reach were driven with fakes: the router shapes the
        // live adapter does not have, and the difference strings a healthy
        // platform never produces.
        "services/api/src/isolation/targets.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/isolation/compare.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },

        // `attack.ts` is NOT at 100, and the remaining arms are named rather than
        // chased. `send`'s empty-body arm and `credentialAttack`'s mint-failure arm
        // both need an HTTP fake to reach, and faking the transport in a file whose
        // subject is real HTTP would test the fake. `rowsOf` was extracted and
        // closed because it holds a real decision — zero rows from an unrecognised
        // shape reads exactly like zero rows from a correctly-scoped list, and only
        // one of those is a pass.
        "services/api/src/isolation/attack.ts": {
          branches: 83,
          functions: 100,
          lines: 100,
          statements: 96,
        },

        // The channel surface's decisions: the scoped read that comes FIRST so a
        // foreign channel and an absent one answer alike, and the ceiling counted
        // from storage before any user is created. The one uncovered branch is the
        // `not_found` outcome after a successful scoped read — the channel deleted
        // between two statements of one call — which nothing in the api can do.
        "services/api/src/channels/channels.service.ts": {
          branches: 75,
          functions: 100,
          lines: 94,
          statements: 94,
        },

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

        // CHAPTER 3.8's limiter. Pinned at what the work achieves, which for the
        // three pure files is everything — they hold no clock, no store and no
        // framework, so a branch they miss is a case nobody thought of rather
        // than a case nobody could reach.
        //
        // `bucket.ts`, `policy.ts` and `fallback.ts` are here at 100 on every
        // metric. `fallback.ts` earns the strictest reading of constitution VI
        // available: it is the mechanism the AUTH limiter degrades to, and R3's
        // whole argument is that this one counter must not fail open. An
        // unmeasured branch in it is a hole in the thing the chapter is about.
        "services/api/src/limits/bucket.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/limits/policy.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/limits/fallback.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },

        // The four that touch a store, a clock or Nest's request pipeline, pinned
        // at measurement rather than at 100. Each shortfall is one branch that
        // needs a real outage at a real instant to reach, and chasing it would
        // mean mocking the thing under test.
        //
        // `store.ts` misses its `downUntil` reset; `auth-limiter.ts` misses the
        // arm where the store answers AND the fallback has an entry;
        // `client-address.ts` misses one shape of malformed body. The gateway's
        // `limits.ts` misses the arm where a recovered store clears `downUntil`
        // mid-window.
        "services/api/src/limits/store.ts": {
          branches: 91,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/limits/auth-limiter.ts": {
          branches: 87,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/limits/client-address.ts": {
          branches: 90,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/limits/rate-limit.middleware.ts": {
          branches: 85,
          functions: 100,
          lines: 96,
          statements: 97,
        },
        "services/gateway/src/limits.ts": {
          branches: 90,
          functions: 100,
          lines: 100,
          statements: 100,
        },

        // CHAPTER 3.11's three, pinned at what they measure, with a reason each.
        //
        // `credit.ts` is here at 100 on everything and has no excuse not to be:
        // two functions, no clock, no store, no framework, and between them they
        // ARE the report protocol — a replay credits nothing, a lost report is
        // repaid by the next, a late one lowers nothing. An unmeasured branch
        // there is a hole in the thing the chapter is about.
        //
        // `usage.controller.ts` reached 100 second. It measured 88.88 / 50 with
        // the 409 tested and the RETHROW beside it untested, which is the branch
        // that separates "this connection moved tenants" from "something else
        // broke". Swallowing the second as the first turns a broken caller into a
        // conflict nobody investigates; the test that closed it reports usage for
        // an environment that does not exist.
        //
        // `meter.ts` is 93.75 on branches and NOT 100, and the shortfall is
        // named rather than chased: the remaining arm is the retention cap's
        // `!closedEntries.has(key)` guard for a duplicate key arriving exactly at
        // the ceiling. Reaching it needs four thousand closed connections and a
        // repeat among them, which is a fixture that would take longer to read
        // than the branch is worth.
        "services/api/src/quotas/credit.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/api/src/internal/usage.controller.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        "services/gateway/src/meter.ts": {
          branches: 93,
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
