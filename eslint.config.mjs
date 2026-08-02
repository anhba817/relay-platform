import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// One lint config for the whole workspace (ADR-01's consequence made literal).
export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
