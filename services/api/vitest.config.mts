import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

// Vitest's default transform (esbuild) strips decorators but never emits
// decorator METADATA — Nest's DI would silently resolve nothing. SWC does
// emit it; `module: { type: "es6" }` keeps test files ESM so vitest can load
// them (this package compiles to CJS, but tests run in vitest's world, not
// node's). The config is .mts for the same reason: inside a
// `"type": "commonjs"` package a .ts config would be loaded as CommonJS,
// which vitest refuses.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: { transform: { legacyDecorator: true, decoratorMetadata: true } },
    }),
  ],
});
