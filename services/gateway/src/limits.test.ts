import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createGatewayLimits, decide, overLimit, windowStartFor } from "./limits.js";

// The gateway's share of the arithmetic (chapter 3.8). Pure, so a window
// boundary is a test rather than a wait.

const MINUTE = 60_000;

describe("windowStartFor", () => {
  it("floors to the window, so two instances agree without talking", () => {
    expect(windowStartFor(90_000, MINUTE)).toBe(60_000);
    expect(windowStartFor(59_999, MINUTE)).toBe(0);
  });
});

describe("overLimit", () => {
  it("is false below the limit and true at it", () => {
    expect(overLimit(599, 600)).toBe(false);
    expect(overLimit(600, 600)).toBe(false);
    expect(overLimit(601, 600)).toBe(true);
  });

  it("TREATS AN UNKNOWN COUNT AS UNDER THE LIMIT", () => {
    // `null` means the store could not be reached. The gateway's two limits are
    // TENANT limits — they protect Relay's capacity from a customer's traffic —
    // so they fail open, exactly as the api's do. This is the direction that is
    // right here and wrong for the auth limiter, which is the chapter's whole
    // argument (research R3).
    expect(overLimit(null, 600)).toBe(false);
  });

  it("a limit of zero refuses everything, and that is expressible on purpose", () => {
    // Null in the policy column means "use the default"; zero means "refuse
    // everything", and an environment can be switched off deliberately. The two
    // states cannot share a representation, so zero has to behave.
    expect(overLimit(1, 0)).toBe(true);
  });
});

describe("decide", () => {
  const at = (ms: number, count: number | null, limit = 600) =>
    decide(count, limit, ms, MINUTE);

  it("reports the reset as one moment, not a curve", () => {
    // The whole reason this is a fixed window and not a token bucket: a
    // refilling bucket's honest answer to "when may I retry" is a slope, and
    // `X-RateLimit-Reset` has room for one number.
    expect(at(90_000, 601).resetSeconds).toBe(120);
    expect(at(119_999, 601).resetSeconds).toBe(120);
  });

  it("never asks a client to retry in zero seconds", () => {
    // 1ms before the boundary the honest answer rounds to 0, and a client that
    // obeys it retries into the same refusal.
    expect(at(119_999, 601).retryAfterSeconds).toBe(1);
    expect(at(60_000, 601).retryAfterSeconds).toBe(60);
  });

  it("floors remaining at zero rather than going negative", () => {
    expect(at(0, 605).remaining).toBe(0);
    expect(at(0, 599).remaining).toBe(1);
  });

  it("reports a full allowance when the store is unreachable", () => {
    // Fail-open all the way through: not over, and the headers say so rather
    // than reporting a count the gateway does not have.
    expect(at(0, null)).toMatchObject({ over: false, remaining: 600 });
  });
});

describe("the gateway's dependencies (SC-011)", () => {
  it("gains no database client, which is the property R12 exists to protect", async () => {
    // ADR-05: the gateway never touches Postgres. Chapter 3.8 needed the
    // environment's limits, which live in Postgres, and the tempting fix was a
    // read-only pool "just for this". R12 spent its whole argument on why not —
    // and then nothing checked it, which is how a design statement becomes a
    // comment. The limits ride the authentication response the gateway was
    // already making, so this file's manifest can stay clean.
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    const runtime = Object.keys(manifest.dependencies);
    for (const forbidden of ["pg", "postgres", "drizzle-orm", "@relay/db"]) {
      expect(runtime).not.toContain(forbidden);
    }
    // `ioredis` IS here, and that is a different claim: Redis is a cache the
    // gateway may hold, Postgres is the source of truth it may not (SAD §6.3).
    expect(runtime).toContain("ioredis");
    // `@relay/api` sits in devDependencies for the integration harness, and it
    // does bring Postgres with it — into the test process, never into `dist`.
    expect(runtime).not.toContain("@relay/api");
  });
});

describe("a store that is not there", () => {
  it("FAILS OPEN, and stops paying the connect timeout on every call", async () => {
    // Port 1 answers nothing. The first `spend` waits out the connect timeout
    // and fails open; the second must NOT — a cache outage that turns every
    // handshake into a one-second wait has converted an unavailable limiter
    // into an unavailable gateway, and NFR-PRF-04 asks for a handshake under a
    // second (research R34).
    const limits = createGatewayLimits("redis://127.0.0.1:1");
    try {
      const first = await limits.spend("env-1", "connect", 600);
      expect(first.over).toBe(false);
      expect(first.remaining).toBe(600);

      const started = Date.now();
      const second = await limits.spend("env-1", "connect", 600);
      expect(second.over).toBe(false);
      // Not "fast enough to feel nice" — fast enough that it cannot have made
      // a connection attempt, whose timeout is a full second.
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      await limits.close();
    }
  }, 15_000);
});
