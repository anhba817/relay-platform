import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// One lint config for the whole workspace (ADR-01's consequence made literal).
export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Dev scripts run on Node directly, outside any package's tsconfig —
    // so the globals have to be declared rather than inferred (chapter 2.5).
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  {
    // Isolation lives in data access, not in handlers (constitution I):
    // only the repository layer may touch the driver.
    //
    // Chapter 3.8 added the SECOND per-tenant store and the same argument
    // applies to it. The rate-limit counters are keyed `rl:{environment_id}:…`,
    // so an unrestricted client would let any handler read or write another
    // tenant's counter — which is the access this rule exists to prevent, and
    // constitution I calls that a correctness property rather than a convention.
    // `services/api/src/limits/**` is the Redis analogue of the repository
    // layer; the gateway holds its own client in `services/gateway/src/limits.ts`
    // and for fan-out in `fanout.ts`.
    //
    // `limits.itest.ts` is the one TEST allowed a raw client, and for a reason
    // the rule cannot express: its whole subject is that the api and the gateway
    // increment the SAME key, and the only way to check that is to read the key
    // with neither of their code.
    files: ["**/*.ts"],
    ignores: [
      "services/api/src/db/**",
      "services/api/src/limits/**",
      "services/gateway/src/limits.ts",
      "services/gateway/src/limits.itest.ts",
      "services/gateway/src/fanout.ts",
      // The test harness IS data access — its whole job is to plant rows the
      // repository layer must never plant and to hold a connection carrying an
      // exemption no product code may carry (feature 030). Restricting it from
      // `pg` would restrict it from existing.
      "packages/test-harness/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message:
                "Raw database access is forbidden outside services/api/src/db (constitution I).",
            },
            {
              name: "drizzle-orm",
              message:
                "The query engine lives inside the repository layer only (constitution I, ADR-16).",
            },
            {
              name: "ioredis",
              message:
                "The counter store lives in services/api/src/limits and services/gateway/src/limits.ts only (constitution I, chapter 3.8). Its keys are per environment; an unrestricted client is a cross-tenant read.",
            },
          ],
          patterns: [
            {
              group: ["drizzle-orm/*"],
              message:
                "The query engine lives inside the repository layer only (constitution I, ADR-16).",
            },
          ],
        },
      ],
    },
  },
  {
    // THE GLOBAL ADMIN FUNCTIONS, RESTRICTED IN INTEGRATION TESTS (feature 030).
    //
    // Six recorded instances of one fault: a test asserts a local fact about a
    // global operation, or performs one and damages a neighbour's fixture. Each
    // one imported one of these functions into an `*.itest.ts` and called it as
    // though the database held only its own rows.
    //
    // The two `*Depth` functions are here for a different reason from the other
    // four. They take no batch size and cannot — a count has nothing to bound —
    // and a global count compared against itself is instance 4, which appeared
    // twice in one file four chapters apart. An earlier draft of this rule said
    // "every cross-environment function must require a batch size"; that was
    // false of these two, which is why they are restricted rather than fixed.
    //
    // WHAT THIS RULE DOES NOT CATCH, and must not be trusted to:
    //   * an indirect call — a helper in another file that calls the function,
    //     imported here under an innocent name;
    //   * raw SQL — `UPDATE webhook_endpoints SET enabled = false` names no
    //     import at all.
    // Both are covered by the trigger in `packages/test-harness/src/sentinel.sql`,
    // which watches statements rather than imports. A rule trusted further than
    // it goes is worse than no rule (contracts/guard.md).
    //
    // AND WHAT NEITHER CATCHES: instance 3 rode the JetStream stream rather than
    // the database — an unfiltered `createConsumerRuntime` in a test replays every
    // event earlier chapters left behind, on a fixed budget of polls. No trigger
    // sees that and no import is wrong; the subject filter is the property, and
    // the call site is the only place to notice it (research R43).
    files: ["**/*.itest.ts"],
    ignores: [
      // The suites that drive a global drain on purpose. THIS LIST AND
      // `packages/test-harness/src/exempt.ts` MUST AGREE: a file exempt from one
      // and not the other is a trap for whoever adds the seventh instance.
      "services/api/src/outbox/outbox.itest.ts",
      "services/api/src/webhooks/deliveries.itest.ts",
      "services/api/src/webhooks/test-event.itest.ts",
      "services/api/src/webhooks/attempts.itest.ts",
      "services/api/src/notifications/notifications.itest.ts",
      "services/dispatcher/src/dispatcher.itest.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // BOTH SPELLINGS. `no-restricted-imports` matches the specifier as
          // written, so `../db/repository` and `./repository` are two rules —
          // and the second is the one `db/repository.itest.ts` and
          // `db/history-drift.itest.ts` would use, both of them non-exempt.
          // Measured by adding the import to each and running eslint.
          paths: [
            {
              name: "../db/repository",
              importNames: [
                "drainOutbox",
                "drainDueDeliveries",
                "drainDisableNotifications",
                // Chapter 3.11 added this one, and chapter 3.10 should have.
                // `drainQuotaNotifications` claims undelivered rows across every
                // environment, exactly as its three siblings above do, and 3.10
                // listed it in neither this rule nor `exempt.ts` — whose comment
                // says the two MUST AGREE.
                //
                // SAY WHAT THIS DOES NOT BUY. It protects a future DIRECT
                // importer. It does not protect the suites that already drive the
                // drain, because they reach it through `createQuotaRelay`, and
                // the note above is explicit that an indirect call is what this
                // rule cannot see. Scoping those assertions to rows the test
                // created is the half that works.
                "drainQuotaNotifications",
                "sweepDisabledEndpoints",
                "outboxDepth",
                "pendingDeliveryDepth",
              ],
              message:
                "This function operates across every environment in the database, and an integration test shares that database with every other suite. Assert on the rows this test created — read them back by id, or scope the count to your own environment_id — instead of on what a global batch happened to contain. If this suite's subject IS the global drain, add it to packages/test-harness/src/exempt.ts with a reason, and to the ignores list beside this rule.",
            },
            {
              name: "./repository",
              importNames: [
                "drainOutbox",
                "drainDueDeliveries",
                "drainDisableNotifications",
                "sweepDisabledEndpoints",
                "outboxDepth",
                "pendingDeliveryDepth",
              ],
              message:
                "This function operates across every environment in the database, and an integration test shares that database with every other suite. Assert on the rows this test created — read them back by id, or scope the count to your own environment_id — instead of on what a global batch happened to contain. If this suite's subject IS the global drain, add it to packages/test-harness/src/exempt.ts with a reason, and to the ignores list beside this rule.",
            },
          ],
        },
      ],
    },
  },
);
