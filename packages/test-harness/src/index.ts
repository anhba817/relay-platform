// The integration lane's own infrastructure (feature 030).
//
// WHY THIS IS A PACKAGE and not a directory inside `services/api`: after the
// guard's exemption had to reach every lane, five vitest configs across four
// packages load it — the api's, the dispatcher's, the gateway's, the e2e
// package's and the root coverage config's. A gateway test lane reaching into
// another service's `src/` is a worse precedent than a shared package, even in
// test code, and `packages/` is where this repository already keeps shared
// things (research R16).
//
// REFERENCED BY PATH, NOT BY NAME, which is why this package publishes no
// `exports` map. By name would mean adding `@relay/test-harness` to four
// `devDependencies` plus the repository root, which has no workspace
// dependencies at all. `setupFiles` and `globalSetup` take paths, and `pg` still
// resolves from this package's own `node_modules` because Node resolves from the
// importing file's location rather than from whichever config loaded it
// (research R20).
//
// Nothing here is product code. It exists only in test databases, is created by
// the lane, and is excluded from coverage for the same reason `main.ts` and
// `*.module.ts` are.

export { SENTINEL, sentinelFor, plant, type Sentinel } from "./sentinel.js";
export { EXEMPT_FILES, isExempt } from "./exempt.js";
