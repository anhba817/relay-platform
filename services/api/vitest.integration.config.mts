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
      // THE OBJECT STORE, IN BOTH LANES THAT RUN `.itest.ts` FILES. Chapter 4.9 put a
      // credential in one of these two configs and not the other, and `pnpm coverage`
      // stayed red — keeping three cross-tenant attacks skipped in the run that measures
      // constitution VI's own coverage bar — until eight minutes of a coverage run said
      // so. The media suites reach a real store; without these they reach nothing and
      // the refusal they get is `media_storage_unavailable`, which is a correct answer
      // to the wrong question.
      RELAY_MINIO_ENDPOINT: "http://localhost:9000",
      RELAY_MINIO_ACCESS_KEY: "relay",
      RELAY_MINIO_SECRET_KEY: "relay-secret",
      RELAY_MINIO_BUCKET: "relay-media",
      RELAY_HARNESS_BAIT: "on",
      RELAY_OUTBOX_RELAY: "off",
      RELAY_EVENT_CONSUMER: "off",
      // The quota relay, the fourth. Same reason as the other three.
      RELAY_QUOTA_RELAY: "off",
      // THE TWO PLATFORM CREDENTIALS, AND ONE MISSING VARIABLE WAS COSTING MORE THAN THE
      // TEST THAT SAID SO (chapter 4.9).
      //
      // `limits.itest.ts` fails loudly without them — *"the lane must configure a platform
      // credential: expected undefined to be truthy"* — and has since before Part 4. That is
      // the visible half. The expensive half is `isolation/gauntlet.itest.ts`, where three
      // attacks on the platform routes read `if (dispatcher === undefined) return;` and
      // **report green without running**. The suite's own accounting test cannot catch it,
      // because `attacked.add(...)` happens before the early return — so the check that
      // exists to find routes nobody attacked is satisfied by the route that was skipped.
      //
      // Constitution VI: *"the cross-tenant suite … gates releases"*. Three of its attacks
      // have not run in this lane, and both halves of that were one unset variable.
      //
      // THE VALUES ARE COMPOSE'S OWN DEFAULTS, so the lane authenticates the way the stack
      // does rather than against a secret invented here. They are ≥32 characters and carry
      // the `rk_svc_` prefix because `resolvePlatformCredential` refuses anything shorter,
      // which is a refusal worth meeting rather than working around.
      //
      // SET HERE RATHER THAN IN EACH SUITE, for feature 030's reason one paragraph up: a
      // convention nobody applied is not a property of the lane. `credentials.itest.ts` still
      // sets and restores its own values inside its own file, which is the case that proves
      // `resolvePlatformCredential` reads at call time.
      RELAY_INTERNAL_CREDENTIAL: "rk_svc_local_development_credential_0000",
      RELAY_INTERNAL_CREDENTIAL_GATEWAY: "rk_svc_local_development_gateway_00000",
    },
    include: ["src/**/*.itest.ts"],
    // FILES IN PARALLEL AGAIN, AND EIGHT PLACES ARE WHY IT COULD NOT BE.
    //
    // This lane ran one file at a time from the outbox chapter, for a real reason: a
    // PENDING migration lets two suites issue `CREATE TYPE` against one schema, and
    // Postgres answers `duplicate key value violates unique constraint
    // "pg_type_typname_nsp_index"` — an error about its own catalogue that reads like a
    // driver fault. That window closed in the instruments chapter, when `globalSetup`
    // began migrating once before any file starts; the setting outlived it by eight
    // chapters. The probe is a fresh database with every file racing, and it passes.
    //
    // What actually kept the files apart was EIGHT places scoped wider than their own
    // subject, spread across eight chapters. The connection-cap chapter has them in a
    // table with what each one really read. Three were known and carried in; five came
    // from running the lane without the setting and reading what fell over, one at a
    // time, over six runs. **Three of the five are not assertions at all.**
    //
    // AND THE WORKER COUNT IS MEASURED, NOT INHERITED. Vitest defaults to roughly one
    // worker per core, which here is nine NestJS applications against one Postgres:
    //
    //   maxWorkers    1      2      3      5    default(9)
    //   api lane    177s   102s   102s   102s     102s
    //   peak used  4188M  4275M  4467M  4817M    5456M
    //
    // **Every second of the saving is in one-to-two.** This lane waits on a shared
    // database and broker far more than it computes, so a second file fills the first
    // one's gaps and a third has no gap left to fill — it just pays for another runtime.
    // The gateway's curve has its knee at FOUR, not two (69s, 46s, 35s, 35s), because its
    // suites each drive a child process of their own; **the right number is per-lane and
    // measured, and a default is neither.** Above the knee it stops being free: the
    // gateway at six workers is no faster than at four and its typing suite starts
    // missing a presence frame.
    maxWorkers: 2,
    //
    // Each of the eight is fixed where it lives. The migration race is left to the one
    // run it can happen on.
  },
});
