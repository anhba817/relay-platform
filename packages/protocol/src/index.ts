// @relay/protocol — the shared wire contract (ADR-01's payoff, chapter 1.3).
// One home for frame schemas, their inferred types, the failure
// vocabulary, the internal service contract the gateway and API service share
// (chapter 2.5), and — from chapter 3.18 — the live fan-out's subject grammar,
// which needed a shared home the moment a second service published to it.
// Consumed by the gateway and API service from 1.4, and by the SDK in a later
// part.

export * from "./frames.js";
export * from "./codes.js";
export * from "./internal.js";
export * from "./fanout.js";
export * from "./presence.js";
export * from "./membership.js";
export * from "./typing.js";
