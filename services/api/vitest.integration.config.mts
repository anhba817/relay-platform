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
    // MEASURED THIS CHAPTER: eight suites in this lane import `AppModule`, and not
    // one of them sets a relay flag. Each relay defaults to on when its flag is
    // unset (`process.env.RELAY_OUTBOX_RELAY ?? "on"`), so those eight booted two
    // background loops that sweep the whole database while every other suite's
    // fixtures sit in it.
    //
    // The exposure looks nil if you only count the suites that spawn an api CHILD
    // and set the flags in the child's env — they do it correctly. The suites that
    // boot the app IN PROCESS are the ones nobody looked at.
    //
    // A relay catches and logs its own errors, so the guard's refusal raised inside
    // one is a log line and a green lane. Setting the flags here makes the quiet
    // database a property of the lane rather than a convention nobody applied — and
    // the list is exactly the relays that exist, because `setup.ts` refuses a name
    // no module reads.
    env: {
      RELAY_HARNESS_BAIT: "on",
      RELAY_OUTBOX_RELAY: "off",
      RELAY_EVENT_CONSUMER: "off",
    },
    include: ["src/**/*.itest.ts"],
    // ONE FILE AT A TIME, BECAUSE THEY SHARE ONE DATABASE.
    //
    // Every suite here runs migrations before it starts. Vitest runs FILES in parallel
    // by default, so several of them issue `CREATE TYPE` against the same schema at the
    // same moment and Postgres answers `duplicate key value violates unique constraint
    // "pg_type_typname_nsp_index"` — an error about its own catalogue, which reads like
    // a driver fault and is not one.
    //
    // It only bites when a migration is PENDING. With the schema already applied every
    // suite finds nothing to do and the race has no window, which is why serialising the
    // turbo tasks was enough until this chapter added a table.
    fileParallelism: false,
  },
});
