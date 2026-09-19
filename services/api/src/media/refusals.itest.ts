import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import { createApiKey, createEnvironment } from "../db/repository";
import { ensureBucket, storeConfig } from "./store";

// FR-MED-02'S REFUSALS, TOLD APART BY CODE (T022, T023, T024a, T025, T026, T027).
//
// BY CODE AND NOT BY STATUS, which is a rule this repository paid for.
// `webhooks.itest.ts` asserted a status and a message and stayed green for four
// chapters while the body said `internal_error` — only the code could have caught it.
// Every assertion here names the code; the status is checked beside it, never instead.

describe("the four refusals", () => {
  let app: INestApplication;
  let url: string;
  let db: Db;
  let env: { id: string };
  let key: { credential: string };
  const store = storeConfig();

  const ask = async (
    body: Record<string, unknown>,
  ): Promise<{ status: number; code: string; message: string; field?: string }> => {
    const res = await fetch(`${url}/v1/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.credential}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as { code: string; message: string; field?: string };
    return { status: res.status, ...parsed };
  };

  /** Rows for THIS environment. A whole-table count is a neighbour's problem in a lane
   *  that runs two files at a time — eight of those were found one failure at a time
   *  across six runs before `check-lane-scope.py` existed (045-74). */
  const rows = async (): Promise<number> => {
    const { rows: r } = (await db.execute(
      `SELECT count(*)::int AS n FROM media_objects WHERE environment_id = '${env.id}'`,
    )) as unknown as { rows: { n: number }[] };
    return r[0]!.n;
  };

  beforeAll(async () => {
    await ensureBucket(store);
    db = createDb(createPool());
    env = await createEnvironment(db, { name: "media-refusals-itest" });
    key = await createApiKey(db, { environmentId: env.id });

    app = (await Test.createTestingModule({ imports: [AppModule] }).compile())
      .createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("refuses a type outside the ten, and names the type it was given", async () => {
    const res = await ask({ filename: "x.exe", mime_type: "application/x-msdownload", bytes: 10 });
    expect(res.code).toBe("media_type_not_allowed");
    expect(res.status).toBe(415);
    // The remedy is to transcode, and a client cannot transcode without knowing what it
    // sent was rejected rather than mangled.
    expect(res.message).toContain("application/x-msdownload");
    expect(res.field).toBe("mime_type");
  });

  it("accepts all ten FR-MED-02 permits, which is what makes the refusal above mean something", async () => {
    // A REFUSAL TEST WITHOUT THIS ONE IS SATISFIED BY A ROUTE THAT REFUSES EVERYTHING.
    const ten = [
      "image/jpeg", "image/png", "image/gif", "image/webp",
      "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav",
      "video/mp4", "video/webm",
    ];
    for (const mime of ten) {
      const res = await ask({ filename: "x", mime_type: mime, bytes: 1024 });
      expect(res.status, `${mime} was refused: ${res.code}`).toBe(201);
    }
  }, 60_000);

  it("refuses a declared size over its kind's cap, and names both figures", async () => {
    const res = await ask({ filename: "big.jpg", mime_type: "image/jpeg", bytes: 10_485_761 });
    expect(res.code).toBe("media_too_large");
    expect(res.status).toBe(413);
    // BOTH FIGURES, because the remedy is to compress and a client cannot compress to an
    // unknown target. One of the two alone is half an instruction.
    expect(res.message).toContain("10485761");
    expect(res.message).toContain("10485760");
    expect(res.field).toBe("bytes");
  });

  it("caps each kind separately — 25 MB of audio passes where 25 MB of image does not", async () => {
    // THE CAPS ARE PER KIND AND THAT IS THE ONLY WAY TO SHOW IT. A single size test
    // passes against one global cap, which is a different design.
    const size = 25 * 1024 * 1024;
    expect((await ask({ filename: "a.mp3", mime_type: "audio/mpeg", bytes: size })).status).toBe(201);
    expect((await ask({ filename: "a.png", mime_type: "image/png", bytes: size })).code).toBe(
      "media_too_large",
    );
  });

  it("writes no row for a refusal, and the accepted request beside it writes one", async () => {
    // FR-009. THE SECOND HALF IS THE CONTROL: "no row" is satisfied by a route that
    // never writes at all, and this suite's other tests would then be measuring nothing.
    const before = await rows();
    await ask({ filename: "x.exe", mime_type: "application/x-msdownload", bytes: 10 });
    await ask({ filename: "big.jpg", mime_type: "image/jpeg", bytes: 10_485_761 });
    expect(await rows()).toBe(before);

    expect((await ask({ filename: "ok.png", mime_type: "image/png", bytes: 10 })).status).toBe(201);
    expect(await rows()).toBe(before + 1);
  });

  it("gives the refusals four distinct codes, and each one is the right one", async () => {
    // DISTINCTNESS IS ONE ASSERTION AND CORRECTNESS IS FOUR. A test that only checks
    // they differ passes when every code is wrong in the same way.
    const type = await ask({ filename: "x.exe", mime_type: "application/x-msdownload", bytes: 10 });
    const size = await ask({ filename: "big.jpg", mime_type: "image/jpeg", bytes: 10_485_761 });
    expect(type.code).toBe("media_type_not_allowed");
    expect(size.code).toBe("media_too_large");
    expect(new Set([type.code, size.code]).size).toBe(2);

    // The other two are exercised where their condition can be made to happen: the store
    // refusal by stopping the container (below), the quota refusal in phase 5's suite.
  });

  // ── FR-017, and the store is taken away rather than stubbed ────────────────────
  //
  // A TEST THAT STUBS THE FAILURE ASSERTS THE STUB. The api reaches the store through
  // `fetch` against a signed URL; there is no client object to mock, and mocking
  // `storeReachable` would assert that a false return produces a 503, which is the one
  // part of this nobody doubts. What has to be real is the unreachable store.
  //
  // AND THE FIRST VERSION STOPPED THE CONTAINER, WHICH BROKE A TEST IN ANOTHER FILE.
  // `docker compose stop minio` takes the store away from the MACHINE, and this lane
  // runs two files at a time — so the isolation gauntlet's own slot request, in
  // `src/isolation/`, answered 503 where it expected 201. Measured at **two of three
  // runs**, with the failure appearing in a file that never mentions media storage.
  //
  // That is 045's rule one level up. Eight assertions were found scoped wider than their
  // own subject; this is an ACTION scoped wider than its own test, and the lane cannot
  // tell the difference — it just goes red somewhere else. **A test may not take a
  // shared service away from its neighbours.**
  //
  // SO THE ENDPOINT MOVES INSTEAD OF THE STORE. Port 1 is privileged and unbindable, so
  // a request to it is refused by the kernel — the same `ECONNREFUSED` a stopped
  // container gives, through the same `fetch`, into the same branch. This lane's pool is
  // `forks`, one process per worker and one file at a time, so `process.env` here is
  // this file's alone; `finally` puts it back either way.
  //
  // AND THE SECOND-APPLICATION VERSION OF THIS DID NOT WORK, which is worth a sentence
  // because it looks like it should. `MediaService` depends on a REQUEST-scoped
  // `Repository`, so Nest makes it request-scoped too and `storeConfig()` runs on every
  // request rather than at boot — an app compiled while the variable was moved still
  // read the restored value when the request arrived. The env has to be wrong AT THE
  // MOMENT OF THE REQUEST, which is what this does.
  it("refuses with the one transient code of the four, and it says retry", async () => {
    // THE CONTROL COMES FIRST, in the same test, against the same app: without it a 503
    // from a broken application is indistinguishable from a 503 about the store.
    expect((await ask({ filename: "a.png", mime_type: "image/png", bytes: 10 })).status).toBe(201);
    const before = await rows();

    const real = process.env.RELAY_MINIO_ENDPOINT;
    let refused: Awaited<ReturnType<typeof ask>>;
    try {
      process.env.RELAY_MINIO_ENDPOINT = "http://127.0.0.1:1";
      refused = await ask({ filename: "a.png", mime_type: "image/png", bytes: 10 });
    } finally {
      if (real === undefined) delete process.env.RELAY_MINIO_ENDPOINT;
      else process.env.RELAY_MINIO_ENDPOINT = real;
    }

    expect(refused.code).toBe("media_storage_unavailable");
    expect(refused.status).toBe(503);
    // THE MESSAGE IS THE POINT OF THE FOURTH CODE. Three refusals are permanent —
    // transcode, compress, free space — and this one is not, so it is the only one
    // allowed to tell a client to try again.
    expect(refused.message).toContain("retried");

    // AND IT WROTE NO ROW. A refusal that reserved bytes against a store the client
    // never reached would leak the tenant's quota one outage at a time.
    expect(await rows()).toBe(before);

    // AND IT RECOVERS WITH NOTHING BUT THE VARIABLE PUT BACK. The refusal was about the
    // store being unreachable and about nothing else in the request.
    expect((await ask({ filename: "a.png", mime_type: "image/png", bytes: 10 })).status).toBe(201);
  }, 60_000);
});
