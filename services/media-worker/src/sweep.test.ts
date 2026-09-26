import { afterEach, describe, expect, it, vi } from "vitest";

import type { InternalMediaVerdictRequest } from "@relay/protocol";
import { createLogger } from "@relay/service-kit";

import { ApiError, VerdictRefusedError, type ApiClient } from "./api-client.js";
import type { StoreConfig } from "./store.js";
import { sweepOnce, verifyDeclaration, type Verify } from "./sweep.js";

const store: StoreConfig = {
  endpoint: "http://store.invalid",
  accessKey: "k",
  secretKey: "s",
  bucket: "b",
};

const logger = createLogger("media-worker-test", () => {});

const object = (id: string) => ({
  id,
  object_key: `k/${id}`,
  mime_type: "image/png",
  declared_bytes: 10,
});

const api = (
  overrides: Partial<ApiClient> & { objects?: ReturnType<typeof object>[] } = {},
): ApiClient => ({
  pending: async () => overrides.objects ?? [],
  verdict: async () => ({ applied: true, state: "ready" }),
  ...overrides,
});

const ready: InternalMediaVerdictRequest = {
  verdict: "ready",
  verified_bytes: 10,
  verified_type: "image/png",
};

const yes = async (): Promise<boolean> => true;

describe("one sweep", () => {
  it("REFUSES TO RUN AGAINST A BUCKETLESS STORE, which is the branch that produces silence", async () => {
    // A missing bucket answers every object's HEAD with 404 and the sweep reads 404 as
    // "not uploaded yet" — so without this branch a bucketless store makes the worker
    // inert AND quiet, which is 056-10's condition one chapter on. The test is that
    // `pending` is never even called.
    const pending = vi.fn(async () => [object("a")]);
    const result = await sweepOnce({
      api: api({ pending }),
      store,
      logger,
      probeBucket: async () => false,
    });
    expect(result.storeUnavailable).toBe(true);
    expect(pending).not.toHaveBeenCalled();
  });

  it("counts an object with no bytes as waiting and sends no verdict", async () => {
    // FR-009 AS AN ABSENCE. There is no `retry` verdict, so the evidence that this
    // path decided nothing is that the api was never called.
    const verdict = vi.fn();
    const result = await sweepOnce({
      api: api({ objects: [object("a")], verdict }),
      store,
      logger,
      probeBucket: yes,
      verify: async () => null,
    });
    expect(result).toMatchObject({ seen: 1, waiting: 1, ready: 0, rejected: 0 });
    expect(verdict).not.toHaveBeenCalled();
  });

  it("sends a verdict and counts it", async () => {
    const result = await sweepOnce({
      api: api({ objects: [object("a"), object("b")] }),
      store,
      logger,
      probeBucket: yes,
      verify: async (o) =>
        o.id === "a"
          ? ready
          : { verdict: "rejected", reason: "scan_failed" },
    });
    expect(result).toMatchObject({ seen: 2, ready: 1, rejected: 1, waiting: 0 });
  });

  it("A PROBE THAT THREW LEAVES THE OBJECT PENDING, not rejected", async () => {
    // The store was unreachable, or the scanner was. Recording that as a verdict would
    // put "we could not tell" in a column somebody later reads as a fact — so the
    // object counts as waiting and the next sweep finds it.
    const verdict = vi.fn();
    const verify: Verify = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await sweepOnce({
      api: api({ objects: [object("a")], verdict }),
      store,
      logger,
      probeBucket: yes,
      verify,
    });
    expect(result).toMatchObject({ seen: 1, waiting: 1 });
    expect(verdict).not.toHaveBeenCalled();
  });

  it("carries on past a refused verdict, and does not count it", async () => {
    // Another worker rejected the object while this one held it. Not this process's
    // failure and not worth retrying: the bytes are already gone.
    const result = await sweepOnce({
      api: api({
        objects: [object("a"), object("b")],
        verdict: async (id) => {
          if (id === "a") throw new VerdictRefusedError(id);
          return { applied: true, state: "ready" };
        },
      }),
      store,
      logger,
      probeBucket: yes,
      verify: async () => ready,
    });
    expect(result).toMatchObject({ seen: 2, ready: 1 });
  });

  it("carries on past an api error, and does not count it", async () => {
    const result = await sweepOnce({
      api: api({
        objects: [object("a"), object("b")],
        verdict: async (id) => {
          if (id === "a") throw new ApiError("verdict", 503);
          return { applied: true, state: "ready" };
        },
      }),
      store,
      logger,
      probeBucket: yes,
      verify: async () => ready,
    });
    expect(result).toMatchObject({ seen: 2, ready: 1 });
  });

  it("counts a vanished row as neither ready nor rejected", async () => {
    // `null` is the api client's way of saying the row is gone — FR-MED-10's reap, or
    // a tenant deleted. Counting it as `ready` would be a fabricated fact about a row
    // nobody has.
    const result = await sweepOnce({
      api: api({ objects: [object("a")], verdict: async () => null }),
      store,
      logger,
      probeBucket: yes,
      verify: async () => ready,
    });
    expect(result).toMatchObject({ seen: 1, ready: 0, rejected: 0 });
  });

  it("an empty backlog is not an error", async () => {
    const result = await sweepOnce({ api: api(), store, logger, probeBucket: yes });
    expect(result).toEqual({ seen: 0, ready: 0, rejected: 0, waiting: 0 });
  });
});

describe("the declaration check, which is the size half of FR-MED-03", () => {
  const head = (status: number, headers: Record<string, string> = {}) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status, headers })),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes an object whose bytes match what was declared", async () => {
    head(200, { "content-length": "10" });
    expect(await verifyDeclaration(object("a"), store)).toMatchObject({
      verdict: "ready",
      verified_bytes: 10,
    });
  });

  it("REJECTS A MISMATCH IN EITHER DIRECTION, and reports the store's number", async () => {
    // A client that declared one byte and uploaded five megabytes is the case FR-MED-03
    // exists for, and a client that declared more than it sent is the same defect with
    // the sign flipped — both are a row whose `declared_bytes` is a lie, and the quota
    // was charged against that number.
    head(200, { "content-length": "5000000" });
    expect(await verifyDeclaration(object("a"), store)).toMatchObject({
      verdict: "rejected",
      reason: "declaration_mismatch",
      verified_bytes: 5_000_000,
    });

    head(200, { "content-length": "3" });
    expect(await verifyDeclaration(object("a"), store)).toMatchObject({
      verdict: "rejected",
      verified_bytes: 3,
    });
  });

  it("answers nothing at all for an object the store does not hold", async () => {
    head(404);
    expect(await verifyDeclaration(object("a"), store)).toBeNull();
  });
});
