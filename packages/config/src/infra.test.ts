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

  it("persists exactly the durable stores — and never Redis", () => {
    for (const volume of DURABLE_VOLUMES) {
      expect(compose).toContain(`${volume}:`);
    }
    expect(compose).not.toContain("redis-data");
  });
});
