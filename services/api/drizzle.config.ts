import { defineConfig } from "drizzle-kit";

// drizzle-kit's job here is GENERATION only: it turns src/db/schema.ts into
// plain SQL files under migrations/, which are reviewed against SAD §6.1
// and applied by src/db/migrate.ts — our runner, our single ledger. Its
// migrator and its journal table are deliberately unused (ADR-16).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
