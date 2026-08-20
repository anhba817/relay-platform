import { defineConfig } from "vitest/config";

// The integration lane (chapter 2.1). *.itest.ts files are invisible to the
// unit lane's include on purpose: `pnpm test` stays Docker-free, and this
// config is what `pnpm --filter @relay/api test:integration` runs against
// the compose Postgres. (.mts because this package compiles to CommonJS —
// a .ts config would be loaded as CJS, which vitest refuses.)
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
    env: {
      RELAY_HARNESS_BAIT: "on",
      RELAY_OUTBOX_RELAY: "off",
      RELAY_DELIVERY_RELAY: "off",
      RELAY_NOTIFICATION_RELAY: "off",
      RELAY_EVENT_CONSUMER: "off",
    },
    include: ["src/**/*.itest.ts"],
  },
});
