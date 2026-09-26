import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "@relay/service-kit";

import { createApiClient, type ApiClient } from "./api-client.js";
import { gifOf, pngOf } from "./fixtures.js";
import { sign, storeConfigFromEnv, type StoreConfig } from "./store.js";
import { sweepOnce } from "./sweep.js";

// THE WORKER AGAINST A REAL API AND A REAL STORE.
//
// THE API RUNS AS A CHILD PROCESS, not in-process — the dispatcher's suite made the same
// choice for the same reason. This service's whole point is that it reaches state over
// the internal seam rather than through a database client, and a suite that imported the
// api's modules would prove that over a function call instead of over HTTP.
//
// THE BYTES ARE PUT THE WAY A CLIENT PUTS THEM: a presigned URL the api signed, which
// the worker never sees. Nothing in this file writes to the store through a back door,
// because ADR-13's claim is that no Relay process handles the upload.

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const API_DIST = join(REPO, "services", "api", "dist");

const WORKER_CREDENTIAL = "rk_svc_media_worker_verify_itest_0123456";

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("api never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("an uploaded image becomes readable", () => {
  let api: ChildProcess;
  let apiUrl: string;
  let client: ApiClient;
  let store: StoreConfig;
  let apiKey: string;
  let environmentId: string;
  let db: unknown;
  let seeder: {
    createDb: (p: unknown) => unknown;
    createPool: () => typeof pool;
    createEnvironment: (db: unknown, o: { name: string }) => Promise<{ id: string }>;
    createApiKey: (db: unknown, o: { environmentId: string }) => Promise<{ credential: string }>;
  };
  let pool: {
    end: () => Promise<void>;
    query: (
      q: string,
      v?: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[] }>;
  };
  const logger = createLogger("verify-itest", () => {});

  /** A slot from the PUBLISHED route, as a customer's backend takes one. */
  const slot = async (
    mimeType: string,
    bytes: number,
  ): Promise<{ id: string; url: string }> => {
    const res = await fetch(`${apiUrl}/v1/media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ filename: "f", mime_type: mimeType, bytes }),
    });
    expect(res.status, "the slot route did not issue an id").toBe(201);
    const body = (await res.json()) as { media_id: string; upload_url: string };
    return { id: body.media_id, url: body.upload_url };
  };

  /** Upload to the store the way a client does: the api's signed URL, and nothing
   * of Relay's in the path. */
  const put = async (url: string, bytes: Uint8Array): Promise<void> => {
    const res = await fetch(url, {
      method: "PUT",
      body: bytes.slice() as unknown as BodyInit,
    });
    expect(res.status, "the presigned PUT was refused").toBe(200);
  };

  /** One object, taken end to end: slot, upload, sweep it specifically. The sweep's
   * own batch is oldest-first over the whole platform, and the lane holds thousands of
   * `pending` rows — so a suite that ran a plain sweep would verify somebody else's
   * backlog and never reach its own fixture. The row is backdated to the front. */
  const sweepFor = async (id: string): Promise<void> => {
    await backdate(id);
    await sweepOnce({ api: client, store, logger, batch: 1 });
  };

  // THROUGH THE API'S OWN POOL, NOT A `pg` CLIENT OF OUR OWN. The workspace's lint rule
  // refuses a raw `pg` import outside the api's `db/` — 4.10 paid for that rule in a test
  // — and the first version of this file reached for `node_modules/pg` at the repo root,
  // where it is not hoisted. `createPool` is the sanctioned door and it is already open.
  //
  // OLDER THAN EVERY OTHER ROW, not merely old. The first version pinned every fixture
  // to `2000-01-01`, so by the third test several rows shared that instant and a batch
  // of one picked whichever the planner reached first — the suite failed with objects
  // left `pending` and nothing wrong with the worker. The lane holds 3,292 `pending`
  // rows and the batch is oldest-first, so being at the head has to be a fact rather
  // than an intention.
  const backdate = async (id: string): Promise<void> => {
    await pool.query(
      "update media_objects set created_at = " +
        "(select coalesce(min(created_at), now()) - interval '1 second' from media_objects) " +
        "where id = $1",
      [id],
    );
  };

  const rowOf = async (id: string): Promise<Record<string, unknown>> => {
    const r = await pool.query(
      "select state, object_key, width, height, verified_bytes, verified_type, " +
        "rejected_reason from media_objects where id = $1",
      [id],
    );
    return r.rows[0]!;
  };

  beforeAll(async () => {
    store = storeConfigFromEnv({
      RELAY_MINIO_ENDPOINT:
        process.env["RELAY_MINIO_ENDPOINT"] ?? "http://localhost:9100",
      ...process.env,
    });

    seeder = require_(join(API_DIST, "db", "repository.js")) as typeof seeder;
    const client_ = require_(join(API_DIST, "db", "client.js")) as typeof seeder;
    pool = client_.createPool();
    db = client_.createDb(pool);
    const env = await seeder.createEnvironment(db, {
      name: `verify-itest-${randomUUID().slice(0, 8)}`,
    });
    environmentId = env.id;
    apiKey = (await seeder.createApiKey(db, { environmentId })).credential;

    const port = 14_713;
    apiUrl = `http://localhost:${port}`;
    api = spawn("node", [join(API_DIST, "main.js")], {
      env: {
        ...process.env,
        PORT: String(port),
        RELAY_INTERNAL_CREDENTIAL_WORKER: WORKER_CREDENTIAL,
        RELAY_OUTBOX_RELAY: "off",
        RELAY_NOTIFICATION_RELAY: "off",
        RELAY_EVENT_CONSUMER: "off",
        RELAY_DELIVERY_RELAY: "off",
        RELAY_QUOTA_RELAY: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForHealth(`${apiUrl}/healthz`);
    client = createApiClient(apiUrl, WORKER_CREDENTIAL);
  }, 60_000);

  afterAll(async () => {
    api?.kill("SIGKILL");
    // SCOPED TO THIS SUITE'S OWN TENANT. Backdated rows left behind would sit at the
    // head of every later run's batch, and the next run's fixtures would be the ones
    // that never got swept — the same defect this suite just worked around, accumulating
    // one run at a time.
    await pool?.query("delete from media_objects where environment_id = $1", [
      environmentId,
    ]);
    await pool?.end();
  });

  it("carries a real PNG from pending to ready, with its dimensions (SC-001)", async () => {
    const png = pngOf(320, 200);
    const { id, url } = await slot("image/png", png.length);
    await put(url, png);

    expect((await rowOf(id))["state"]).toBe("pending");
    await sweepFor(id);

    const row = await rowOf(id);
    expect(row["state"]).toBe("ready");
    expect(row["width"]).toBe(320);
    expect(row["height"]).toBe(200);
    expect(Number(row["verified_bytes"])).toBe(png.length);
    expect(row["verified_type"]).toBe("image/png");
  });

  it("LEAVES AN OBJECT WITH NO BYTES PENDING, which is the commonest outcome", async () => {
    // A 404 from the store is "not uploaded yet", never "rejected". 91.6% of this lane's
    // `pending` rows are in exactly this state, and FR-MED-10's reap at 24 hours is a
    // different mechanism with a different clause.
    const { id } = await slot("image/png", 100);
    await sweepFor(id);
    expect((await rowOf(id))["state"]).toBe("pending");
  });

  it("REJECTS A GIF DECLARED AS A PNG, at exactly the right byte count", async () => {
    // The size half alone cannot see this, and neither can the store's own headers: a
    // presigned PUT echoes whatever `content-type` the client sent. Only the bytes say.
    const gif = gifOf(64, 64);
    const { id, url } = await slot("image/png", gif.length);
    await put(url, gif);
    await sweepFor(id);

    const row = await rowOf(id);
    expect(row["state"]).toBe("rejected");
    expect(row["rejected_reason"]).toBe("declaration_mismatch");
    expect(row["verified_type"]).toBe("image/gif");
  });

  it.each([
    ["one byte over", 1],
    ["one byte under", -1],
    ["five thousand over", 5_000],
  ])("REJECTS A SIZE THAT DISAGREES BY %s", async (_label, delta) => {
    // EXACT, NOT "MATERIALLY DIFFERENT". FR-MED-03 says *"contradict their
    // declaration"*; this task and the acceptance scenario both said "materially" and
    // neither gave a tolerance. **The quota is what settles it**: `reserveMediaSlot`
    // sums `declared_bytes` (SRS 1.17), so under any tolerance a client that
    // under-declares is billed for the declaration and stores the difference. Exact
    // comparison makes the quota correct by construction — for every `ready` object,
    // `verified_bytes = declared_bytes`.
    //
    // ONE BYTE IS THE TEST THAT MATTERS. A five-thousand-byte mismatch passes under a
    // tolerance too, so a suite that only tested the large case would be green against
    // the design this one refuses.
    const png = pngOf(32, 32);
    const { id, url } = await slot("image/png", png.length + delta);
    await put(url, png);
    await sweepFor(id);

    const row = await rowOf(id);
    expect(row["state"]).toBe("rejected");
    expect(row["rejected_reason"]).toBe("declaration_mismatch");
    expect(Number(row["verified_bytes"])).toBe(png.length);
  });

  it("AND FOR EVERY READY OBJECT THE TWO NUMBERS ARE EQUAL", async () => {
    // The invariant the exact comparison buys, asserted over the tenant's whole set
    // rather than over one row — because it is a property of the quota, not of a test.
    const r = await pool.query(
      "select count(*) as n from media_objects " +
        "where environment_id = $1 and state = 'ready' and verified_bytes <> declared_bytes",
      [environmentId],
    );
    expect(Number(r.rows[0]!["n"])).toBe(0);
  });

  it("A REJECTED OBJECT STOPS COUNTING AGAINST THE TENANT'S STORAGE (T033)", async () => {
    // THROUGH THE SAME SUM THE SLOT ROUTE USES, not through a number this test
    // computes its own way. Otherwise a rejected upload holds a tenant's storage
    // forever and nothing says so until they hit the cap.
    const committed = async (): Promise<number> => {
      const r = await pool.query(
        "select coalesce(sum(declared_bytes), 0) as c from media_objects " +
          "where environment_id = $1 and state <> 'rejected'",
        [environmentId],
      );
      return Number(r.rows[0]!["c"]);
    };

    const gif = gifOf(24, 24);
    const before = await committed();
    const { id, url } = await slot("image/png", gif.length);
    await put(url, gif);
    expect(await committed(), "a pending object must count").toBe(before + gif.length);

    await sweepFor(id);
    expect((await rowOf(id))["state"]).toBe("rejected");
    expect(await committed()).toBe(before);

    // AND THE DECLARATION SURVIVES. The row is the audit record FR-MED-04 keeps, so
    // `declared_bytes` still says what the client claimed — the bytes stop counting
    // because the ROW left the sum, not because the column was zeroed.
    const r = await pool.query(
      "select declared_bytes from media_objects where id = $1",
      [id],
    );
    expect(Number(r.rows[0]!["declared_bytes"])).toBe(gif.length);
  });

  it("AN MP4 UPLOADED AS image/png IS REJECTED, HOWEVER THE PUT WAS LABELLED (T035)", async () => {
    // THE TEST THAT SAYS WHERE `verified_type` COMES FROM. The PUT below sends
    // `content-type: image/png`, and the store echoes it back on every later `HEAD` —
    // measured. If this passed, the platform would be reading the client's own claim
    // twice and calling the second reading a verification.
    const mp4 = new Uint8Array([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
    ]);
    const { id, url } = await slot("image/png", mp4.length);
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: mp4.slice() as unknown as BodyInit,
    });
    expect(res.status).toBe(200);

    await sweepFor(id);
    const row = await rowOf(id);
    expect(row["state"]).toBe("rejected");
    expect(row["verified_type"]).toBe("video/mp4");
  });

  it("AND THE REJECTED OBJECT'S BYTES ARE GONE (FR-MED-04)", async () => {
    const gif = gifOf(16, 16);
    const { id, url } = await slot("image/png", gif.length);
    await put(url, gif);

    const key = (await rowOf(id))["object_key"] as string;

    await sweepFor(id);
    expect((await rowOf(id))["state"]).toBe("rejected");

    const head = await fetch(
      sign(store, { method: "HEAD", key, expiresIn: 60 }),
      { method: "HEAD" },
    );
    expect(head.status, "the rejected object's bytes are still in the store").toBe(404);
  });

  it("REFUSES TO SWEEP A STORE WITH NO BUCKET, and says so (FR-009)", async () => {
    // SCOPED TO A BUCKET THAT DOES NOT EXIST, which is the safest possible version of
    // 056-5's rule: `docker compose stop minio` is the truest test and it is an action
    // wider than its own test — 4.10's version made `gauntlet.itest.ts` answer 503 in a
    // file that never mentions media. A bucket nobody has affects nobody.
    const absent = { ...store, bucket: `probe-${randomUUID()}` };
    const result = await sweepOnce({ api: client, store: absent, logger, batch: 1 });
    expect(result.storeUnavailable).toBe(true);
    expect(result.seen).toBe(0);
  });

  it("AND WITHOUT THAT CHECK IT WOULD REPORT A QUIET PASS FOREVER", async () => {
    // THE RED HALF, RUN RATHER THAN ARGUED. With the bucket probe forced true against
    // the same absent bucket, every object's `HEAD` answers 404 — a HEAD carries no
    // body, so `NoSuchBucket` and `NoSuchKey` are the same answer — and the sweep reads
    // every one of them as "not uploaded yet". Nothing goes red, nothing is logged as
    // an error, and objects simply never become `ready`.
    //
    // That is 056-10's condition in the component best placed to notice it: a store
    // that had never held a bucket answered every slot request 503 forever, invisible
    // locally because the volume persists.
    const absent = { ...store, bucket: `probe-${randomUUID()}` };
    const result = await sweepOnce({
      api: client,
      store: absent,
      logger,
      batch: 5,
      probeBucket: async () => true,
    });
    expect(result.storeUnavailable).toBeUndefined();
    expect(result.seen).toBe(5);
    expect(result.waiting).toBe(5);
    expect(result.ready + result.rejected).toBe(0);
  });

  it("and the control: the real bucket is present", async () => {
    // Without this the two tests above pass against a store that is simply down, which
    // would make them assertions about the network rather than about the bucket.
    const result = await sweepOnce({ api: client, store, logger, batch: 0 });
    expect(result.storeUnavailable).toBeUndefined();
  });

  it("A SECOND PASS DOES NOT RE-READ THE BYTES (FR-008, SC-005)", async () => {
    // The seam's half is covered by `media-verdict.itest.ts` — a second `ready` answers
    // `applied: false`. THIS is the worker's half, and it had no task until analysis
    // pass 1: an idempotent verdict is worth nothing if the worker streams 100 MB
    // through a scanner to reach it. Counted by watching the store, not by asserting
    // that a method was called.
    const png = pngOf(48, 48);
    const { id, url } = await slot("image/png", png.length);
    await put(url, png);
    await sweepFor(id);
    expect((await rowOf(id))["state"]).toBe("ready");

    const key = (await rowOf(id))["object_key"] as string;
    const real = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(key)) reads += 1;
      return real(input, init);
    }) as typeof fetch;
    try {
      await sweepOnce({ api: client, store, logger, batch: 50 });
    } finally {
      globalThis.fetch = real;
    }

    // ZERO REQUESTS FOR **THIS** KEY, not zero requests. The first version counted every
    // call to the store's host and expected one — the bucket probe — and measured two,
    // because the lane holds 3,292 other `pending` rows and the next sweep reads one of
    // them. That is the worker working. **An assertion scoped wider than the thing it
    // tests fails for somebody else's reason**, and here it would have read as a
    // re-download that never happened.
    expect(reads).toBe(0);
  });
});
