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
);
