// @relay/protocol — the shared wire contract (ADR-01's payoff, chapter 1.3).
// One home for frame schemas, their inferred types, the failure
// vocabulary, and — from chapter 2.5 — the internal service contract the
// gateway and API service share. Consumed by the gateway and API service
// from 1.4, and by the SDK in a later part.

export * from "./frames.js";
export * from "./codes.js";
export * from "./internal.js";
