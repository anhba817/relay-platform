import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COMPOSE_FILE, DURABLE_VOLUMES, INFRA_SERVICES } from "./infra.js";

// The gate stays Docker-free: these assertions read the compose declaration as
// text — no daemon, no containers. They fail if a store is renamed or dropped,
// if a healthcheck disappears (docker compose up -d --wait would silently stop
// meaning "ready"), or if Redis quietly gains a volume it must never need.

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

describe("the compose declaration agrees with @relay/config", () => {
  const compose = readFileSync(join(repoRoot, COMPOSE_FILE), "utf8");

  it("declares every infra service", () => {
    for (const service of INFRA_SERVICES) {
      expect(compose).toMatch(new RegExp(`^  ${service}:$`, "m"));
    }
  });

  it("gives every service a healthcheck — up --wait must mean ready", () => {
    const healthchecks = compose.match(/^ {4}healthcheck:$/gm) ?? [];
    expect(healthchecks.length).toBeGreaterThanOrEqual(INFRA_SERVICES.length);
  });

  it("REGISTERS every compose service, which is the direction this file lacked", () => {
    // The assertion above runs one way: every registered service must appear in
    // compose. Nothing ran the other way, so a container added to compose and
    // never registered here was invisible — `INFRA_SERVICES` would quietly stop
    // naming the local infrastructure while every test still passed. Chapter
    // 3.8 added a fifth container and the gap is how it nearly went unnoticed.
    //
    // The services behind `--profile services` are Relay's own and are not
    // infrastructure, so they are excluded by name rather than by pattern: a
    // list is auditable and a pattern would silently absorb the next container.
    const ours = new Set(["api", "gateway", "dispatcher"]);
    // Only the `services:` block. Volume names sit at the same indentation one
    // block down, and a match that swept the whole file would report
    // `postgres-data` as an unregistered service.
    const services = compose.slice(0, compose.indexOf("\nvolumes:"));
    const declared = [...services.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
      .map((match) => match[1] as string)
      .filter((service) => !ours.has(service));
    expect([...declared].sort()).toEqual([...INFRA_SERVICES].sort());
  });

  it("persists exactly the durable stores — and never Redis", () => {
    for (const volume of DURABLE_VOLUMES) {
      expect(compose).toContain(`${volume}:`);
    }
    expect(compose).not.toContain("redis-data");
  });
});
