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
  // Chapter 3.17. THE SUBJECT IS A ROW NO REPOSITORY METHOD CAN WRITE ANY MORE, which
  // is the same reason the three quota suites are here. `sendMessage` requires a sender
  // as of FR-MSG-15, so a senderless message — 121,250 of them exist in the lane, and
  // any deployment older than chapter 3.17 has them — can only be planted by hand. The
  // arms that read one (history's `user: null`, the resume's drop) have no other fixture.
  //
  // Exempted explicitly rather than reached through a helper in another file: the note
  // at the top of this rule says a helper would make the SQL invisible to it, and an
  // invisible exemption is worse than a listed one.
  "services/api/src/internal/backfill.itest.ts",
  // Chapter 3.18. THE SAME ARGUMENT AS THE TWO LIMITS SUITES: its subject is what
  // reaches the fabric, and the only way to check that is to subscribe with
  // neither the api's publisher nor the gateway's `createFanout`. A spy on either
  // would prove that an object was asked to publish, not that a frame arrived —
  // and the isolation gauntlet cannot cover this path at all, because its oracle
  // compares response bodies and a publish is a second output channel.
  "services/api/src/fanout/fanout.itest.ts",
  "services/api/src/messages/history.itest.ts",
  // Chapter 3.19, and it is 3.18's argument in the other direction. The presence
  // fabric's receive half has two rejection paths — a body that is not JSON, and a
  // body that is JSON and not a transition — and neither can be reached through
  // `createPresence`, which only ever publishes payloads its own schema produced.
  // Putting arbitrary bytes on `presence:{channel_id}` needs a client that belongs to
  // neither module, exactly as checking what reaches `chan:{id}` did.
  //
  // A `publish` and nothing else: this file reads no key and composes none.
  "services/gateway/src/presence.itest.ts",
  // Chapter 3.20's, for that same reason and on THIS list rather than the `**/*.ts`
  // block's `ignores` — which is where it was written first, and where an `.itest.ts`
  // entry does nothing. The `**/*.itest.ts` block below REPLACES the rule for every
  // integration test not on one of these two lists, so an exemption above it is
  // overwritten in silence. This file's header states that hazard (R23, FR-043) and
  // the entry still went to the wrong list.
  //
  // The membership fabric's receive half has the same two rejection paths presence's
  // has — a body that is not JSON, and JSON the schema refuses — and neither is
  // reachable through `createMembership`, which only delivers what it already
  // accepted. A `publish` and nothing else: no key read, no key composed.
  "services/gateway/src/membership.itest.ts",
  // Chapter 3.21, and the same case as the two above: the assertion is on Redis,
  // read with neither service's code. A publish count taken through this
  // chapter's own module would be satisfied by a module that does nothing —
  // chapter 3.18's warning, in a new place.
  "services/gateway/src/typing.itest.ts",
  // Chapter 3.22, and NOT for the reason the four above give. This file needs no
  // raw client to assert a publish — its subject is delivery, and it asserts on
  // the sockets. It needs one to CAUSE a membership change: `Membership` exposes
  // `onChange`, `subscribeChannel` and `watch` and no `publish`, because the api
  // publishes and the gateway only ever subscribes. So the raw client is the
  // stimulus rather than the oracle, which is a fifth reason this rule cannot
  // express and the reason it is listed here explicitly.
  "services/gateway/src/connections.itest.ts",
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
      // Chapter 3.18. THE RULE'S REASON DOES NOT APPLY HERE, and that is the
      // whole justification rather than a convenience. The restriction exists
      // because rate-limit counters are keyed `rl:{environment_id}:…`, so an
      // unrestricted client can read another tenant's counter. This client
      // touches no keys: it calls PUBLISH and nothing else, onto
      // `chan:{channel_id}` — a channel UUID, not an environment-scoped key —
      // and a subject is not readable at all, only listened to by whoever is
      // already subscribed. The gateway's `fanout.ts` is on this list one line
      // up for the same reason; the api needs it too now that it publishes.
      "services/api/src/fanout/**",
      // Chapter 3.20, AND IT IS THE ENTRY ABOVE'S CASE RATHER THAN THE LIMITER'S.
      // The membership publisher calls PUBLISH and nothing else, onto
      // `member:{channel_id}` and `member:{env}:{user}` — a subject is not
      // readable at all, only listened to by whoever is already subscribed, so
      // there is no key here for a cross-tenant read to reach.
      //
      // The SECOND of those subjects carries an environment id, which is the
      // shape the restriction guards, and it still does not make this the
      // limiter's case: the id is composed from the repository's own scope on
      // the way out, never read from a payload on the way in. The gateway's half
      // of this fabric IS the limiter's case, and its entry says so.
      "services/api/src/membership/**",
      // Chapter 3.19. THIS IS `limits.ts`'s CASE, NOT `fanout.ts`'s, and the
      // distinction is the rule's own reason. The entry above is justified by
      // "this client touches no keys" — a publish onto a channel UUID, and a
      // subject is not readable at all. Presence's client touches keys and they
      // are environment-scoped: `presence:{env}:{user}`, exactly the shape the
      // restriction exists to guard.
      //
      // So the justification is the limiter's instead: it composes every key from
      // the environment id on the authenticated connection's own identity, and it
      // reads no key it did not compose. There is no path here that takes an
      // environment id from a client, and no scan, `KEYS` or pattern read that
      // could reach a key belonging to another tenant.
      "services/gateway/src/presence.ts",
      // Chapter 3.20, AND IT IS THE FAN-OUT'S CASE RATHER THAN PRESENCE'S — the
      // opposite of what the entry above had to argue. This client SUBSCRIBES and
      // nothing else: no `SET`, no `EXISTS`, no key of any kind, because the
      // module's only command-shaped work is an HTTP re-read against the api.
      //
      // One of its two subject shapes carries an environment id
      // (`member:{env}:{user}`) and that still does not make it presence's case: a
      // subject is not readable, only listened to by whoever already subscribed, and
      // the id is composed from the authenticated connection's own identity on the
      // way in. There is no path here that takes an environment id from a payload.
      "services/gateway/src/membership.ts",
      // Chapter 3.21, AND IT IS THE FAN-OUT'S CASE — the cleanest of the four, and
      // the only one of them that both publishes and subscribes. This client calls
      // PUBLISH and SUBSCRIBE and nothing else, onto `typing:{channel_id}` — a
      // channel UUID, not an environment-scoped key — and a subject is not readable
      // at all, only listened to by whoever is already subscribed.
      //
      // No environment id appears in the subject, so this entry does not even need
      // the argument the two above had to make. The environment travels INSIDE the
      // payload, where a receiving gateway checks it against the connection it is
      // about to act on; it is never composed into a key, because this module
      // composes no keys.
      //
      // THE `.itest.ts` FILE IS NOT LISTED HERE. Chapter 3.20 put an `.itest.ts`
      // entry in this block's `ignores` and the later `**/*.itest.ts` block
      // silently overrode it. The typing suite's exemption lives in
      // `DRIVER_EXEMPT_TESTS` instead, which is the list that governs test files.
      "services/gateway/src/typing.ts",
      // Chapter 3.22's connection registry, and its keys are the strongest case on
      // this list rather than the weakest. `conn:{env}:{user}:{slot}` puts the
      // environment FIRST, so Principle I is structural in the key itself: a
      // cross-tenant read would need a caller to hand this module another
      // environment's id, which the session layer takes from the api's verified
      // identity and never from a payload.
      //
      // The `.itest.ts` file is NOT listed here, for the reason the typing note
      // above gives: the later `**/*.itest.ts` block would silently override it.
      // Its exemption is in `DRIVER_EXEMPT_TESTS`, and so is `connections.test.ts`'s
      // — a unit test, but one that reads the module's own source from disk.
      "services/gateway/src/connections.ts",
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
  {
    // THE SEAL ON `packages/outsider` (chapter 3.14, FR-030, FR-034, R12).
    //
    // That package holds one suite that behaves like a customer, and the claim it
    // makes — an integration built from published documentation alone — is worth
    // nothing if the suite can read the platform's source. So the claim is made
    // mechanical, in three levels, and this block is levels 2 and 3.
    //
    // LEVEL 1 IS NOT A RULE AT ALL. `packages/outsider/package.json` declares no
    // `@relay/*` dependency, and pnpm's isolated `node_modules` means there is no
    // `@relay` directory at the workspace root — so
    // `import { ERROR_CODES } from "@relay/protocol"` fails to RESOLVE. Nothing
    // lints it; the module is not there.
    //
    // LEVEL 2 is the import rule below: a specifier that climbs out of the package
    // by a relative or absolute path is refused. That closes the obvious way round
    // level 1, which is to spell the same import as `../protocol/src/codes.js`.
    //
    // LEVEL 3 is the syntax rule, and an import rule cannot reach it.
    // `packages/e2e/src/harness.ts:31` builds `join(HERE, "..", "..", "..")` and
    // spawns the api's build output from it — a STRING, not an import specifier, so
    // `no-restricted-imports` never sees it. The file cited as proof the hole
    // exists is also proof the import rule does not close it. So `".."` as a
    // literal is banned here, and so is `createRequire`, which is the other way to
    // turn a computed path into a module.
    //
    // WHAT NONE OF THE THREE CLOSES, and three rules must not be left to imply a
    // fourth: reading the repository's source with human eyes. Whoever writes that
    // suite can open `codes.ts` in an editor, and no configuration can stop them.
    // The seals make workspace code unIMPORTABLE; not reading it is a discipline,
    // and the chapter says so in those words rather than presenting three rules as
    // if they were four (FR-034).
    // LAST IN THE FILE, AND THAT IS THE FIX RATHER THAN A TIDYING. This block sat
    // BEFORE the `**/*.itest.ts` blocks on its first draft, and the outsider's only
    // file is `integrate.itest.ts` — so a later block set `no-restricted-imports`
    // again and the seal was not in force. `npx eslint` on a file importing
    // `@relay/protocol` reported NOTHING.
    //
    // That is R23's fault a second time, in the same chapter, in code written by
    // whoever had just finished fixing the first instance. One rule name, one
    // winner: the last matching block. So this one is last, and it carries the
    // union it needs — the driver and engine ban included, because `pg` DOES
    // resolve here by the ordinary parent walk even though `@relay/*` does not.
    //
    // `no-restricted-syntax` survived the first draft only because no other block
    // sets it. Level 3 worked by luck, which is not a property to rely on.
    files: ["packages/outsider/**/*.ts", "packages/outsider/**/*.mts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: DRIVER_AND_ENGINE.paths,
          patterns: [
            ...DRIVER_AND_ENGINE.patterns,
            {
              group: ["@relay/*"],
              message:
                "packages/outsider integrates from published documentation alone. It may not import workspace code — see the three levels in eslint.config.mjs.",
            },
            {
              // NOT `/*` as a third entry here: minimatch matched `vitest/config`
              // with it, and a rule that refuses the test runner is a rule
              // somebody turns off. Absolute paths are covered by the syntax
              // selector below, which matches on the specifier itself.
              group: ["../*", "../../*"],
              message:
                "packages/outsider may not reach outside itself. A relative path out of the package is the same import by another spelling.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value='..']",
          message:
            "packages/outsider may not build a path out of the package. `join(HERE, \"..\", …)` is how packages/e2e reaches the api's build output, and an import rule cannot see it.",
        },
        {
          selector: "CallExpression[callee.name='createRequire']",
          message:
            "createRequire turns a computed path into a module, which is the escape the import rule cannot see.",
        },
        {
          selector: "ImportDeclaration[source.value='node:module']",
          message:
            "node:module is only useful here for createRequire, which is banned above.",
        },
        {
          // An absolute path is the third spelling of the same import. Matched on
          // the specifier rather than by glob, because the glob for it also
          // matched `vitest/config`.
          selector: "ImportDeclaration[source.value=/^\\//]",
          message:
            "packages/outsider may not import by absolute path. See the three levels in eslint.config.mjs.",
        },
      ],
    },
  },
);
