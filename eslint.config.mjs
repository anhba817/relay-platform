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
      // DRIVER_EXEMPT — the lane's own infrastructure. Reasons, one per path:
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
