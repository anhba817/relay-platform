import { defineConfig } from "vitest/config";

// The dispatcher's integration lane (chapter 3.5). Same convention 2.1
// established for the api and 2.6 for the gateway: *.itest.ts is invisible to
// the Docker-free unit include, so `pnpm test` stays runnable with no stores.
export default defineConfig({
  test: {
    // Feature 030: the global-operation guard. `globalSetup` migrates and
    // then installs the trigger once per lane; `setupFiles` sets the
    // exemption for files on the harness's list and, where the lane carries
    // bait, plants it per file.
    globalSetup: ["../../packages/test-harness/src/global-setup.ts"],
    setupFiles: ["../../packages/test-harness/src/setup.ts"],
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
    // NO BAIT IN THIS LANE (feature 030, research R44). Measured: 200 bait
    // deliveries alone, on a freshly migrated database, fail 10 of this suite's 16
    // tests — with instance 5's fix in place. The suite waits 8 seconds for the
    // dispatcher process to deliver its own row, and the dispatcher consumes a
    // shared FIFO stream, so 200 jobs ahead of it exhaust the poll. Bait that fails
    // the suite whether or not the fault is present carries no information.
    //
    // The exemption handling stays: the trigger is database state and outlives
    // whichever lane installed it, so every lane pointed at that database meets it.
    env: {
      RELAY_HARNESS_BAIT: "on",
      RELAY_OUTBOX_RELAY: "off",
      RELAY_DELIVERY_RELAY: "off",
      RELAY_NOTIFICATION_RELAY: "off",
      RELAY_EVENT_CONSUMER: "off",
    },
    include: ["src/**/*.itest.ts"],
    // A delivery to a hostile endpoint spends real time on timeouts and the
    // widening schedule. The default 5 s would fail the suite for being honest.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
