import { defineConfig } from "vitest/config";

// THE SEALED INTEGRATION (chapter 3.12, FR-030, FR-031).
//
// This package holds one suite that behaves like a customer: it reads two URLs
// and a credential from the environment, speaks HTTP and WebSocket, and knows
// nothing else about Relay. It is the SRS Phase 2 exit criterion — "an external
// developer integrates using only public documentation, with no assistance" —
// made into something that either passes or fails.
//
// WRITTEN FROM SCRATCH, NOT COPIED FROM A SIBLING, and that was a deliberate
// instruction rather than a preference. Every other integration config in this
// workspace points `globalSetup` and `setupFiles` at
// `../../packages/test-harness/src/…` — so copying one reaches into another
// package on its second line, which is exactly the thing this package exists to
// be unable to do. It needs neither: it touches no database, so there is nothing
// to migrate, no guard to arm and no bait to plant.
//
// NO `test` SCRIPT in package.json either. The Docker-free unit lane must not
// look here: with no platform running, every test in this suite fails, and it
// should — "the platform is not up" is the correct answer to a request to
// integrate against it, not a reason to soften the suite.
export default defineConfig({
  test: {
    include: ["src/**/*.itest.ts"],
    // A socket handshake and a fan-out hop against a real stack, not a stub.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
