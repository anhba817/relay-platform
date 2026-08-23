import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// ── THE TWO RESTRICTION SETS, NAMED SO THEY CAN BE COMBINED ──────────────────
//
// `no-restricted-imports` is one rule, and in flat config a later block REPLACES
// an earlier block's setting for it rather than merging. That is the bug chapter
// 3.12 found (R23, FR-043): a second block for `**/*.itest.ts` carrying feature
// 030's global-drain restriction switched the driver-and-engine ban OFF for every
// integration test in the workspace. Measured — `npx eslint
// services/api/src/quotas/period.itest.ts` exited 0 while that file imports
// `drizzle-orm` and is on no exemption list.
//
// So the sets live here as data and each block below composes the union it needs.
// Three blocks rather than two, because the two exemption lists are different
// files and a single block can only have one `ignores`.
//
// WHAT THIS RULE DOES NOT BUY, and it is the same boundary feature 030 drew for
// its own half: it sees an IMPORT. A test that reaches raw SQL through a helper in
// another file, or through the repository's own `db` handle, names none of these
// specifiers and is invisible to it. `packages/test-harness/src/sentinel.sql`
// watches statements instead, which is why both exist.
const DRIVER_AND_ENGINE = {
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
};

// The files that legitimately need the driver or the engine in an integration
// test — a LIST WITH REASONS, not a directory pattern, by the doctrine
// `exempt.ts` states. `services/api/src/isolation/**` is deliberately ABSENT:
// its suites read through the repository and through `db/catalogue.ts`, written
// to this constraint rather than around it, which is the point of restoring the
// rule in the chapter that adds them.
const DRIVER_EXEMPT_TESTS = [
  // The repository layer's own suites — the layer under test IS the query layer.
  "services/api/src/db/repository.itest.ts",
  "services/api/src/db/history-drift.itest.ts",
  // The harness IS data access (see the note on `packages/test-harness/**`).
  "packages/test-harness/src/guard.itest.ts",
  // Redis, read with neither service's code, which is the whole subject: the api
  // and the gateway must increment the SAME key.
  "services/api/src/limits/limits.itest.ts",
  "services/gateway/src/limits.itest.ts",
  // The quota suites drive period rollover and connection accounting by writing
  // rows no repository method writes — a period boundary in the past, a
  // connection open across a rollover.
  "services/api/src/quotas/quotas.itest.ts",
  "services/api/src/quotas/period.itest.ts",
  "services/api/src/quotas/connections.itest.ts",
];


// Feature 030's global-admin functions, and the suites whose SUBJECT is the global
// drain. THIS LIST AND `packages/test-harness/src/exempt.ts` MUST AGREE: a file
// exempt from one and not the other is a trap for whoever adds the seventh
// instance.
const DRAIN_EXEMPT_TESTS = [
  "services/api/src/outbox/outbox.itest.ts",
  "services/api/src/webhooks/deliveries.itest.ts",
  "services/api/src/webhooks/test-event.itest.ts",
  "services/api/src/webhooks/attempts.itest.ts",
  "services/api/src/notifications/notifications.itest.ts",
  "services/dispatcher/src/dispatcher.itest.ts",
];

const GLOBAL_DRAINS = {
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
};

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
    // The tests allowed a raw client are named in `DRIVER_EXEMPT_TESTS` above, and
    // `services/gateway/src/limits.itest.ts` is one of them for a reason the rule
    // cannot express: its whole subject is that the api and the gateway increment
    // the SAME key, and the only way to check that is to read the key with neither
    // of their code.
    //
    // CORRECTED IN 3.12 (T069c). This comment used to say it was "the one TEST
    // allowed a raw client". Every test was allowed one, and had been since the
    // `**/*.itest.ts` block below was added — that block replaced this rule rather
    // than adding to it, which is the whole of R23. Its `ignores` entry here has
    // been redundant for exactly as long and stays only because this block also
    // covers the file as plain `**/*.ts`.
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
      "no-restricted-imports": ["error", DRIVER_AND_ENGINE],
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
    // AND WHAT NEITHER THIS NOR THE TRIGGER CATCHES: instance 3 rode the
    // JetStream stream rather than the database — an unfiltered
    // `createConsumerRuntime` in a test replays every event earlier chapters left
    // behind, on a fixed budget of polls. No trigger sees that and no import is
    // wrong; the subject filter is the property, and the call site is the only
    // place to notice it (research R43).
    //
    // THREE BLOCKS, and the shape is the fix rather than a tidying (R23, FR-043).
    // This block carries the UNION for every integration test that needs neither
    // exemption. The two below carry one set each, for the two exemption lists —
    // because a block has one `ignores` and the lists are different files, so a
    // single block would have had to exempt both sets from both rules.
    files: ["**/*.itest.ts"],
    ignores: [...DRAIN_EXEMPT_TESTS, ...DRIVER_EXEMPT_TESTS],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...DRIVER_AND_ENGINE.paths, ...GLOBAL_DRAINS.paths],
          patterns: DRIVER_AND_ENGINE.patterns,
        },
      ],
    },
  },
  {
    // The driver-exempt suites still get the drain restriction. Reading raw SQL
    // is why they are on that list; draining every environment's rows is not.
    files: DRIVER_EXEMPT_TESTS,
    rules: {
      "no-restricted-imports": ["error", GLOBAL_DRAINS],
    },
  },
  {
    // And the drain-exempt suites still get the driver ban. Their subject is the
    // global drain, which says nothing about whether they may hold a raw client.
    files: DRAIN_EXEMPT_TESTS,
    rules: {
      "no-restricted-imports": ["error", DRIVER_AND_ENGINE],
    },
  },
);
