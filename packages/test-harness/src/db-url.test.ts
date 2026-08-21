import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_DATABASE_URL } from "./db-url.js";

// The harness duplicates the api's default connection string, because a package
// may not import service source. This is what stops the copy drifting.

const CLIENT = join(
  import.meta.dirname, "..", "..", "..",
  "services", "api", "src", "db", "client.ts",
);

describe("the harness's default connection string", () => {
  it("is the one services/api/src/db/client.ts declares", () => {
    const text = readFileSync(CLIENT, "utf8");
    const m = /DEFAULT_DATABASE_URL\s*=\s*\n?\s*"([^"]+)"/.exec(text);
    // A regex that matches nothing passes vacuously — if the api renames or
    // reformats the constant, this must fail rather than fall silent.
    expect(m, `no DEFAULT_DATABASE_URL literal found in ${CLIENT}`).not.toBeNull();
    expect(DEFAULT_DATABASE_URL).toBe(m![1]);
  });
});
