import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InternalMediaVerdictRequest } from "@relay/protocol";
import { createLogger } from "@relay/service-kit";

import { ApiError, VerdictRefusedError, type ApiClient } from "./api-client.js";
import type { StoreConfig } from "./store.js";
import { refusedByTheApi, sweepOnce, type Verify } from "./sweep.js";

const store: StoreConfig = {
  endpoint: "http://store.invalid",
  accessKey: "k",
  secretKey: "s",
  bucket: "b",
};

const logger = createLogger("media-worker-test", () => {});

let clock = 0;
const object = (id: string) => ({
  id,
  object_key: `k/${id}`,
  // 4.15: the worker builds a rendition's key as `${environment_id}/${uuid}`, the same
  // layout an upload gets, so the tenant travels on the pending item.
  environment_id: "00000000-0000-0000-0000-0000000000e1",
  mime_type: "image/png",
  declared_bytes: 10,
  // Ascending, because the sweep pages on this value and two rows sharing it would
  // make the cursor skip one — which is a real hazard of a keyset cursor on a
  // non-unique column and is why this fixture never repeats one.
  created_at: new Date(1_700_000_000_000 + (clock += 1000)).toISOString(),
});

const api = (
  overrides: Partial<ApiClient> & { objects?: ReturnType<typeof object>[] } = {},
): ApiClient => ({
  // ONE PAGE AND THEN NOTHING, which is what a short page means to the sweep. A fake
  // that returned the same rows for every cursor would make the pass loop to its bound.
  pending: async (_limit: number, after?: string) =>
    after === undefined ? (overrides.objects ?? []) : [],
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

describe("an object the api refuses with a 4xx", () => {
  beforeEach(() => refusedByTheApi.clear());
  afterEach(() => refusedByTheApi.clear());

  it("IS NOT RETRIED, because a 400 is this worker's bug and not a transient failure", async () => {
    // Measured before this branch existed: a signed-shift defect made the PNG reader
    // report a negative width, the verdict schema refused it with 400, and the worker
    // re-streamed the same eight objects through ClamAV every second for as long as it
    // ran. The log said exactly what was wrong and nothing acted on it.
    const verdict = vi.fn(async () => {
      throw new ApiError("verdict", 400);
    });
    const deps = {
      api: api({ objects: [object("a")], verdict }),
      store,
      logger,
      probeBucket: yes,
      verify: async () => ready,
    };
    await sweepOnce(deps);
    expect(verdict).toHaveBeenCalledTimes(1);

    // The second sweep does not even look at it.
    const second = await sweepOnce(deps);
    expect(verdict).toHaveBeenCalledTimes(1);
    expect(second.seen).toBe(0);
  });

  it("but a 5xx IS retried, because that one is the api's and may pass", async () => {
    const verdict = vi.fn(async () => {
      throw new ApiError("verdict", 503);
    });
    const deps = {
      api: api({ objects: [object("a")], verdict }),
      store,
      logger,
      probeBucket: yes,
      verify: async () => ready,
    };
    await sweepOnce(deps);
    await sweepOnce(deps);
    expect(verdict).toHaveBeenCalledTimes(2);
  });

  it("and a REFUSED verdict (422) is not remembered either — it needs no retry", async () => {
    // 422 means somebody else rejected the object, so the row has already left
    // `pending` and the batch will not contain it again. Adding it to the set would be
    // a second mechanism for something the query already handles.
    const deps = {
      api: api({
        objects: [object("a")],
        verdict: async (id: string) => {
          throw new VerdictRefusedError(id);
        },
      }),
      store,
      logger,
      probeBucket: yes,
      verify: async () => ready,
    };
    await sweepOnce(deps);
    expect(refusedByTheApi.size).toBe(0);
  });
});

describe("one sweep is a whole pass", () => {
  it("PAGES UNTIL THE QUEUE IS EXHAUSTED, because the head never moves on its own", async () => {
    // Measured against a lane with real history: 858 objects in FR-MED-10's window and
    // a batch of fifty. An object nobody uploaded to stays `pending` until the reap, so
    // the first page is the same fifty rows forever and a fresh upload — row 858 — is
    // never reached. The sealed suite timed out at thirty seconds with the worker
    // running perfectly and logging nothing, because it logs only when something
    // happened.
    const all = Array.from({ length: 125 }, (_, i) => object(`o${i}`));
    const pages: Array<string | undefined> = [];
    const result = await sweepOnce({
      api: api({
        pending: async (limit: number, after?: string) => {
          pages.push(after);
          const from = after
            ? all.findIndex((o) => o.created_at === after) + 1
            : 0;
          return all.slice(from, from + limit);
        },
      }),
      store,
      logger,
      batch: 50,
      probeBucket: yes,
      verify: async () => null,
    });
    expect(result.seen).toBe(125);
    // 50, 50, 25 — and the third page is short, which is what ends the pass.
    expect(pages).toHaveLength(3);
    expect(pages[0]).toBeUndefined();
  });

  it("and the pass is BOUNDED, so a queue growing faster than it drains cannot hang it", async () => {
    // A page that is always full never ends on its own. `maxPages` is what stops one
    // sweep running forever — and the objects it gives up on are the NEWEST, which is
    // the right end: an object a second late beats an object never looked at.
    let served = 0;
    const result = await sweepOnce({
      api: api({
        pending: async (limit: number) => {
          served += 1;
          return Array.from({ length: limit }, () => object(`endless-${served}`));
        },
      }),
      store,
      logger,
      batch: 10,
      maxPages: 4,
      probeBucket: yes,
      verify: async () => null,
    });
    expect(served).toBe(4);
    expect(result.seen).toBe(40);
  });
});
