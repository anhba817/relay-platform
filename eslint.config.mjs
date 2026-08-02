import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// One lint config for the whole workspace (ADR-01's consequence made literal).
export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Isolation lives in data access, not in handlers (constitution I):
    // only the repository layer may touch the driver.
    files: ["**/*.ts"],
    ignores: ["services/api/src/db/**"],
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
