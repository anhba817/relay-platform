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
    // THE RATE-LIMIT CHAPTER ADDS THE SECOND PER-TENANT STORE and the same argument
    // applies to it. The counters are keyed `rl:{environment_id}:…`, so an
    // unrestricted client would let any handler read or write another tenant's
    // counter — which is the access this rule exists to prevent, and constitution I
    // calls that a correctness property rather than a convention.
    // `services/api/src/limits/**` is the Redis analogue of the repository layer, and
    // it is exempt as a DIRECTORY for the same reason `db/**` is: it IS the layer the
    // rule carves out. Every other Redis client in the tree is listed by path —
    // including the gateway's half of this same store, `services/gateway/src/limits.ts`,
    // which is one file rather than a layer.
    //
    // AND THE LANE'S OWN INFRASTRUCTURE, NAMED FILE BY FILE. The harness opens raw
    // connections deliberately: one carrying the guard's exemption and one without,
    // which is the distinction its tests are about, and `createPool()` cannot express
    // it. So these three are exempt — as PATHS, not as a `packages/test-harness/**`
    // pattern, because a pattern would silently absorb the next file added there and
    // that is the failure mode the guard itself exists to remove.
    //
    // The exemption is checked in both directions. This rule catches an unlisted
    // file that imports the driver; nothing here can catch a LISTED file that stopped
    // importing it, so the list can only grow and a stale entry holds a standing
    // exemption forever. `driver-exempt.test.ts` reads this array and asserts each
    // path exists and still imports a module the rule below restricts — with those
    // module names read out of the rule rather than restated.
    files: ["**/*.ts"],
    ignores: [
      "services/api/src/db/**",
      "services/api/src/limits/**",
      // DRIVER_EXEMPT — every path below is exempt from all three restricted modules,
      // the driver's name on the marker notwithstanding: `driver-exempt.test.ts` reads
      // the module names out of the rule, so this list governs whatever the rule names.
      //
      // First the lane's own infrastructure. Reasons, one per path:
      //   global-setup.ts  installs the guard against a database vitest names
      //   setup.ts         rewrites the connection string to carry the exemption
      //   guard.itest.ts   holds one exempt client and one plain one, and the
      //                    difference between them is the whole test
      "packages/test-harness/src/global-setup.ts",
      "packages/test-harness/src/setup.ts",
      "packages/test-harness/src/guard.itest.ts",
      // AND THE LANE RESET'S OWN TEST, which arrives with the table it clears. It
      // asserts what the SCRIPT DID — a stale pending backlog gone, an organisation
      // count unmoved — and both are facts about rows the script reached through its
      // own connection. Going through the repository layer would mean asserting the
      // script's effect against the code the script does not use.
      "packages/test-harness/src/reset-lane.itest.ts",
      // AND TWO SUITES THAT WRITE A ROW THE TYPE SYSTEM FORBIDS.
      //
      //   backfill.itest.ts  asserts what `toFrame` does with a SENDERLESS message.
      //                      Those rows exist — every one written through the socket
      //                      before the sender was threaded looks like this — and the
      //                      repository can no longer produce one, because `userId` is
      //                      required. The fixture has to be raw SQL or the behaviour
      //                      has no test at all.
      //   history.itest.ts   reads the same row from the other end: a page whose
      //                      `user` comes back null. FR-MSG-15 made `sendMessage`
      //                      require a sender, so this suite lost the ability to build
      //                      its own fixture in the same change that gave it the case.
      //
      // This is the exemption's honest case: not "the repository is inconvenient" but
      // "the state under test is one the repository is now unable to reach". Both are
      // listed by path rather than reached through a shared helper, because a helper in
      // another file names none of these specifiers and this rule sees only imports —
      // an invisible exemption is worse than a listed one.
      "services/api/src/internal/backfill.itest.ts",
      "services/api/src/messages/history.itest.ts",
      // THE QUOTA CHAPTER'S PERIOD SUITE, and its case is the two above's in a third
      // shape: the state under test is one the repository cannot reach. `periodOf`
      // returns the month a timestamp falls in, and the property is that a row INSERTED
      // under that value is FOUND by it — which needs a `usage_periods` row written
      // directly, because every repository path that writes one derives the period from
      // the clock and so cannot disagree with the function under test.
      //
      // A suite that used the repository here would be asserting that `periodOf` equals
      // itself.
      "services/api/src/quotas/period.itest.ts",
      // AND THE QUOTA SUITE ITSELF, for a different reason from its sibling above.
      // `period.itest.ts` writes a row the repository cannot; this one READS the two
      // roll-up tables directly to check what a send left behind. Going through
      // `usageFor` would mean asserting the roll-up against the function that reads
      // it — the same circularity, one table over.
      "services/api/src/quotas/quotas.itest.ts",
      // AND THE CONNECTION-METERING CHAPTER'S, WHICH MAKES THE SAME CLAIM ONE
      // DIMENSION OVER: a credited minute survives a `FLUSHALL` of the counter store,
      // because a quota is about THIS MONTH and the rate limiter's store is allowed to
      // lose things. Proving that needs the flush, and the flush needs a raw client.
      //
      // LISTED RATHER THAN DODGED. Published's version reached for
      // `await import("ioredis")` inside the test, which this rule cannot see — an
      // exemption that is invisible, which the note at the top of this block calls
      // worse than a listed one. The static import puts it back under the rule and
      // this entry is the answer.
      "services/api/src/quotas/connections.itest.ts",
      // ── AND EVERY OTHER REDIS CLIENT, BY PATH, WITH THE ARGUMENT IT NEEDS ──
      //
      // The rule arrives here and TWELVE files older than it already import `ioredis`.
      // A missing exemption is not a silent one — this rule goes red on a chapter
      // nobody is editing — so all of them land in the commit that adds the rule.
      // FIVE DIFFERENT ARGUMENTS, and a blanket "the gateway's Redis files" would
      // erase all five distinctions the rule exists to make.
      //
      // (1) NO KEY IS TOUCHED AT ALL — these name a pub/sub SUBJECT and never a key,
      // which is the property, not whether they publish or subscribe. The subjects are
      // `chan:{channel_id}`, `member:{channel_id}` and `typing:{channel_id}`: a channel
      // UUID, and a subject is not readable at all, only listened to by whoever already
      // subscribed. There is no key here for a cross-tenant read to reach. (The api's
      // two publishers publish; the gateway's `membership.ts` only ever subscribes,
      // because the api publishes that fabric — and the argument is the same either
      // way.)
      "services/api/src/fanout/publisher.ts",
      "services/api/src/membership/publisher.ts",
      //
      // (2) THE COUNTER STORE'S OTHER HALF. `rl:{environment_id}:…` is the key shape
      // the whole restriction is about, and this file composes it — so it is exempt as
      // the rule's own subject, not against its reason. `limits.itest.ts` is listed
      // beside it for something the rule cannot express at all: its subject is that
      // the api and the gateway increment the SAME key, and the only way to check that
      // is to read the key with NEITHER of their code.
      "services/gateway/src/limits.ts",
      "services/gateway/src/limits.itest.ts",
      "services/gateway/src/fanout.ts",
      // `member:{env}:{user}` — the principal-addressed half of that fabric — DOES
      // carry an environment id, and that still does not make it the limiter's case:
      // a subject is not readable, and the id is composed from the repository's own
      // scope on the way out and from the authenticated connection's identity on the
      // way in, never read from a payload.
      "services/gateway/src/membership.ts",
      // `typing.ts` both publishes and subscribes and composes no key at all — the
      // environment travels INSIDE the payload, where the receiving gateway checks it
      // against the connection it is about to act on.
      "services/gateway/src/typing.ts",
      //
      // (2) KEYS ARE COMPOSED AND THEY ARE ENVIRONMENT-SCOPED — the limiter's own
      // argument rather than the publishers'. `presence:{env}:{user}` is exactly the
      // shape the restriction guards. Every key is composed from the environment id on
      // the authenticated connection's own identity; no path takes one from a client,
      // and there is no scan, `KEYS` or pattern read that could reach another tenant's.
      "services/gateway/src/presence.ts",
      //
      // (3) THE ENVIRONMENT COMES FIRST IN THE KEY, which is the strongest case on
      // this list rather than the weakest. `conn:{env}:{user}:{slot}` makes
      // constitution I structural in the key itself: reaching across a tenant needs a
      // caller to hand this module another environment's id, and the session layer
      // takes that from the api's verified identity. The other entries argue about
      // what they touch; this one cannot be wrong without being lied to.
      "services/gateway/src/connections.ts",
      //
      // (4) THE SUBJECT IS WHAT REACHES THE FABRIC, so the oracle cannot be either
      // service's own client. A spy on `createFanout` or on `createPresence` proves
      // that an object was asked to publish, not that a frame arrived — and these
      // suites' receive halves have rejection paths (a body that is not JSON, a body
      // that is JSON and not a transition) that no module-level API can produce,
      // because each only ever publishes payloads its own schema built.
      "services/api/src/fanout/fanout.itest.ts",
      "services/gateway/src/presence.itest.ts",
      "services/gateway/src/membership.itest.ts",
      "services/gateway/src/typing.itest.ts",
      //
      // (5) THE RAW CLIENT IS THE STIMULUS, NOT THE ORACLE — a fifth reason, and the
      // rule cannot express it. This suite's subject is delivery and it asserts on
      // sockets. It needs a client to CAUSE a membership change: `Membership` exposes
      // `onChange`, `subscribeChannel` and `watch` and no `publish`, because the api
      // publishes and the gateway only ever subscribes.
      "services/gateway/src/connections.itest.ts",
      //
      // `services/gateway/src/connections.test.ts` IS DELIBERATELY ABSENT, and the
      // ledger that owed these entries said to add it. It reads the module's own
      // source off disk and imports nothing restricted, so the exemption would be one
      // over nothing — and `driver-exempt.test.ts`'s stale-entry check is the half of
      // this list that goes red when a listed file stops needing it.
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
                "The counter store lives in services/api/src/limits and services/gateway/src/limits.ts only (constitution I). Its keys are per environment; an unrestricted client is a cross-tenant read.",
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
);
