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
    // THE DOCKER-FREE GATE, MADE DOCKER-FREE AGAIN.
    //
    // `ci.yml` calls `pnpm test` *"the Docker-free gate, exactly as chapter 1.1 defined
    // it"* and it stopped being one when the request-log producer joined the middleware
    // chain: every booted api opened a broker connection, and `main.test.ts > logs exactly
    // one structured line per request` counted the producer's own failure line as a second
    // line. Measured — `RELAY_NATS_URL=nats://127.0.0.1:1` turns it red locally, and in CI
    // the broker is reachable while the stream is not, which is the same two lines with
    // `NatsError: 503` in the second.
    //
    // SET HERE RATHER THAN IN CI, because the claim is about the lane and not about one
    // runner. A variable in `ci.yml` would leave every developer's `pnpm test` depending on
    // a broker they were told they did not need.
    env: { RELAY_REQUEST_LOG: "off" },
  },
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: { transform: { legacyDecorator: true, decoratorMetadata: true } },
    }),
  ],
});
