import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NODE_VERSION_RANGE,
  TOOLCHAIN_CHECKS,
  WORKSPACE_GLOBS,
} from "./index.js";

// The smoke test that makes "tested state" mean something on day one: the
// shared constants must agree with the workspace's real manifests — if the
// root package.json and @relay/config ever tell different stories, this fails.

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

describe("@relay/config agrees with the workspace manifests", () => {
  const rootPkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { engines: { node: string }; scripts: Record<string, string> };

  it("pins the same Node version range as the root manifest", () => {
    expect(rootPkg.engines.node).toBe(NODE_VERSION_RANGE);
  });

  it("names exactly the toolchain checks the root manifest provides", () => {
    for (const check of TOOLCHAIN_CHECKS) {
      expect(rootPkg.scripts).toHaveProperty(check);
    }
  });

  it("lists the same workspace globs as pnpm-workspace.yaml", () => {
    const workspaceYaml = readFileSync(
      join(repoRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    for (const glob of WORKSPACE_GLOBS) {
      expect(workspaceYaml).toContain(`"${glob}"`);
    }
  });
});
