import { defineConfig } from "vitest/config";

// The media worker's integration lane. Same convention 2.1 established for the api and
// 2.6 for the gateway: `*.itest.ts` is invisible to the Docker-free unit include, so
// `pnpm test` stays runnable with no stores.
//
// NO BAIT AND NO RELAY FLAGS. This service boots no NestJS application and starts no
// background relay — it is a loop over two HTTP clients — so the quiet-database
// machinery the api and dispatcher lanes need has nothing to act on here. Stated rather
// than copied: 050 recorded a probe that copied a shape and dropped its guards, and the
// opposite mistake is copying guards that guard nothing.
export default defineConfig({
  test: {
    globalSetup: ["../../packages/test-harness/src/global-setup.ts"],
    setupFiles: ["../../packages/test-harness/src/setup.ts"],
    include: ["src/**/*.itest.ts"],
    // SERIAL, AND THIS LANE IS THE ONE THAT NEEDS IT.
    //
    // `GET /internal/media/pending` is oldest-first over the WHOLE platform and takes
    // no tenant parameter — that is the isolation property the route is built around.
    // It also means two suites sweeping at once are sweeping the same queue: both
    // backdate their fixture to the head, the second one wins, and the first suite's
    // sweep verifies the second suite's object. Measured: six tests red across two
    // files, every one of them `expected 'pending' to be 'ready'`, with nothing wrong
    // in the worker.
    //
    // **An assertion scoped wider than the thing it tests fails for somebody else's
    // reason** (045-74) — and here it is not an assertion that is too wide but the
    // ACTION, which is 056-5's shape. `check-lane-scope.py` cannot see it either,
    // because the scope that is missing is in a route's contract rather than in SQL.
    fileParallelism: false,
    // A SWEEP WAITS ON ITS OWN INTERVAL, and a suite that spawns the worker as a child
    // waits for at least one pass. `vitest.integration.config.mts` in the api sets no
    // `testTimeout` at all, which 4.10 found hiding a 20-second deadline inside a
    // 5-second test — so this one says the number.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
