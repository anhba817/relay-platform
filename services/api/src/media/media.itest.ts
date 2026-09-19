import "reflect-metadata";

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { createDb, createPool, type Db } from "../db/client";
import {
  createApiKey,
  createEnvironment,
  environmentSigningSecret,
  Repository,
} from "../db/repository";
import { mintUserToken } from "../auth/user-token";
import { presign } from "./presign";
import { ensureBucket, storeConfig } from "./store";

// THE SLOT, END TO END (FR-MED-01), AND THE INSTRUMENT IT NEEDS.
//
// SC-001 is *"no byte of the file reaches the api"*, verified by the api's own request
// log. That log is written by `services/ingester`, which has **no Dockerfile and no
// compose service** — so on a machine where nothing drains the stream the rows do not
// exist and an assertion over them passes against an empty table.
//
// `request-log.itest.ts` has carried that hole since chapter 4.4 and chapter 4.9 closed
// it (050-8) by spawning the process the suite needs. This suite does the same, and
// reports what it drained rather than asserting it: a durable consumer drains the whole
// stream and not this file's share of it.
const INGESTER = join(__dirname, "..", "..", "..", "..", "services", "ingester", "dist", "main.js");

const CLICKHOUSE = process.env.RELAY_CLICKHOUSE_URL ?? "http://localhost:8123";

async function ch(query: string): Promise<string> {
  const res = await fetch(CLICKHOUSE, {
    method: "POST",
    headers: { "x-clickhouse-user": "relay", "x-clickhouse-key": "relay" },
    body: query,
  });
  if (!res.ok) throw new Error(`clickhouse: ${res.status} ${await res.text()}`);
  return res.text();
}

describe("the upload slot", () => {
  let ingester: ChildProcess | undefined;
  const drained = { batches: 0, written: 0 };
  let app: INestApplication;
  let url: string;
  let db: Db;
  let env: { id: string };
  let key: { credential: string };
  let token: string;
  const store = storeConfig();

  const slot = async (
    body: Record<string, unknown>,
    credential: string,
  ): Promise<{ status: number; body: Record<string, string>; requestId: string }> => {
    const res = await fetch(`${url}/v1/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, string>,
      requestId: res.headers.get("x-request-id") ?? "",
    };
  };

  /** The uploader recorded against a slot, read straight out of Postgres. */
  const userOf = async (mediaId: string): Promise<string | null> => {
    const { rows } = (await db.execute(
      `SELECT user_id FROM media_objects WHERE id = '${mediaId}'`,
    )) as unknown as { rows: { user_id: string | null }[] };
    return rows[0]?.user_id ?? null;
  };

  /** The timestamp of one request's own row, once the ingester has written it.
   *
   *  POLL TO A DEADLINE FOR WHAT MUST ARRIVE. A flat sleep before an assertion is a bet
   *  that the lane is idle, and this project has one red in twenty runs to show for it. */
  const settle = async (requestId: string): Promise<string | null> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const ts = (
        await ch(`SELECT toString(ts) FROM relay_analytics.api_requests FINAL
                   WHERE request_id = toUUID('${requestId}')`)
      ).trim();
      if (ts !== "") return ts;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  /** Rows for this tenant strictly after an instant. `ts` is stamped when the request is
   *  SERVED, not when it is ingested, so this excludes the three slot calls above whatever
   *  order the ingester happens to write them in. */
  const requestsAfter = async (environmentId: string, ts: string): Promise<number> =>
    Number(
      (
        await ch(`SELECT count() FROM relay_analytics.api_requests FINAL
                   WHERE environment_id = toUUID('${environmentId}')
                     AND ts > toDateTime64('${ts}', 3, 'UTC')`)
      ).trim(),
    );

  beforeAll(async () => {
    if (!existsSync(INGESTER)) {
      throw new Error(`${INGESTER} does not exist; run \`pnpm build\` before this lane`);
    }
    ingester = spawn("node", [INGESTER], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    ingester.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.includes("ingester.batch")) continue;
        try {
          const batch = JSON.parse(line) as { written?: number };
          drained.batches += 1;
          drained.written += batch.written ?? 0;
        } catch {
          // a partial line across two chunks
        }
      }
    });

    await ensureBucket(store);

    db = createDb(createPool());
    env = await createEnvironment(db, { name: "media-itest" });
    key = await createApiKey(db, { environmentId: env.id });

    // The user the token acts as. A user token's slot records the uploader and an API
    // key's does not, which is the distinction FR-MED-06's chapter asks about.
    const repo = new Repository(db, env.id);
    await repo.createUser("media-itest-user");
    const signingSecret = (await environmentSigningSecret(db, env.id))!.signingSecret;
    token = (
      await mintUserToken(signingSecret, {
        user: "media-itest-user",
        environmentId: env.id,
        ttlSeconds: 3600,
      })
    ).token;

    app = (await Test.createTestingModule({ imports: [AppModule] }).compile())
      .createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    ingester?.kill("SIGTERM");
    process.stdout.write(
      `media.itest: the ingester drained ${drained.batches} batches, ${drained.written} records\n`,
    );
    await app?.close();
    if (env !== undefined) {
      await ch(`DELETE FROM relay_analytics.api_requests
                 WHERE environment_id = toUUID('${env.id}')`);
    }
  });

  it("issues a slot with a user token", async () => {
    const res = await slot(
      { filename: "holiday.jpg", mime_type: "image/jpeg", bytes: 2_097_152 },
      token,
    );
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("pending");
    expect(res.body.media_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.upload_url).toContain("X-Amz-Signature=");
    expect(Date.parse(res.body.expires_at!)).toBeGreaterThan(Date.now());
  });

  it("issues a slot with an API key, and the row carries no user", async () => {
    const res = await slot({ filename: "a.png", mime_type: "image/png", bytes: 1024 }, key.credential);
    expect(res.status).toBe(201);
    expect(await userOf(res.body.media_id!)).toBeNull();
  });

  it("records the user for a user token, which FR-MED-06 later asks about", async () => {
    const res = await slot({ filename: "b.png", mime_type: "image/png", bytes: 1024 }, token);
    expect(res.status).toBe(201);
    // NOT `.not.toBeNull()` ALONE. The api-key test above would pass against a column
    // that is always NULL and this one against a column that is always set; together
    // they only mean something if the two answers differ, which is what the pair asserts.
    expect(await userOf(res.body.media_id!)).not.toBeNull();
  });

  // T015, AS A TEST RATHER THAN AS A DESIGN NOTE. "The URL is derived, never stored" is
  // a claim about a schema, and a schema changes. The store answers `Request has expired`
  // from its own clock, so a second record of when the URL lapses would be a second source
  // of truth for one fact — constitution IV, one level down.
  it("stores nothing about the URL it just handed out", async () => {
    const res = await slot({ filename: "d.png", mime_type: "image/png", bytes: 512 }, token);
    expect(res.status).toBe(201);
    expect(res.body.upload_url).toContain("X-Amz-Signature=");

    const { rows } = (await db.execute(
      `SELECT * FROM media_objects WHERE id = '${res.body.media_id}'`,
    )) as unknown as { rows: Record<string, unknown>[] };
    const row = rows[0]!;

    // NOT A COLUMN-NAME CHECK ALONE. A column called `notes` holding the URL would pass
    // one; this asks whether the row holds the bytes.
    const stored = JSON.stringify(row);
    const signature = new URL(res.body.upload_url!).searchParams.get("X-Amz-Signature")!;
    expect(stored).not.toContain(signature);
    expect(stored).not.toContain("X-Amz-");
    expect(stored).not.toContain(store.endpoint);

    // And the structural half, because the value half would also pass on an empty row.
    expect(Object.keys(row).sort()).toEqual([
      "created_at",
      "declared_bytes",
      "environment_id",
      "filename",
      "id",
      "mime_type",
      "object_key",
      "state",
      "user_id",
    ]);
  });

  // C5 / 056-10. THE BUCKET NOTHING CREATED.
  //
  // `store.ts` said *"on boot, every boot"* and every caller of `ensureBucket` was a test
  // `beforeAll` — including this file's. So the api never created the bucket, and on a
  // store that had never held one every slot request answered 503 forever. No local run
  // could see it: the volume persists, so from the first suite onward the bucket was
  // simply there. CI's empty volume is what said so, through two files that never touch
  // this module.
  //
  // A FRESH BUCKET NAME RATHER THAN A DELETED VOLUME. The honest condition is "a store
  // with no bucket", and there are two ways to produce it: remove the shared one, or ask
  // for one that has never existed. The first is an action scoped wider than its own test
  // — `gaps.md` 056-5, this chapter's own finding — and would break any suite running
  // beside this one. The second disturbs nobody.
  it("issues a slot against a bucket that has never existed, and creates it", async () => {
    const fresh = `probe-${randomUUID()}`;
    const real = process.env.RELAY_MINIO_BUCKET;
    const config = { ...store, bucket: fresh };

    // The control: nothing is there yet. A signed HEAD on a bucket the store does not
    // have answers 404, which is the arm this test exists for.
    expect((await fetch(presign({ method: "HEAD", ...config, expiresIn: 60 }),
      { method: "HEAD" })).status).toBe(404);

    try {
      // `MediaService` depends on a REQUEST-scoped `Repository`, so Nest makes it
      // request-scoped too and `storeConfig()` runs on every request. The variable has to
      // be wrong at the moment of the request, not at the moment of the wiring — a second
      // application compiled while it was moved answered 201 from the real bucket.
      process.env.RELAY_MINIO_BUCKET = fresh;
      const res = await slot({ filename: "first.png", mime_type: "image/png", bytes: 32 }, token);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.upload_url).toContain(`/${fresh}/`);
    } finally {
      if (real === undefined) delete process.env.RELAY_MINIO_BUCKET;
      else process.env.RELAY_MINIO_BUCKET = real;
    }

    // AND THE BUCKET IS THERE NOW, which is the half that distinguishes "the slot was
    // issued" from "the slot was issued against something a client could use".
    expect((await fetch(presign({ method: "HEAD", ...config, expiresIn: 60 }),
      { method: "HEAD" })).status).toBe(200);

    // A PROBE CLEANS UP AFTER ITSELF. 043 left two rows behind and the next measurement
    // read them as pre-existing data; a bucket per run would accumulate in a volume every
    // other suite shares.
    const removed = await fetch(presign({ method: "DELETE", ...config, expiresIn: 60 }),
      { method: "DELETE" });
    expect(removed.status, "the probe bucket was left behind").toBe(204);
  }, 60_000);

  it("hands back a URL a client can upload to, and no byte reaches the api", async () => {
    const res = await slot({ filename: "c.jpg", mime_type: "image/jpeg", bytes: 44 }, token);
    expect(res.status).toBe(201);

    // THE SLOT REQUEST'S OWN ROW IS THE FLOOR. Without it "nothing was logged after this
    // instant" is satisfied by a table the ingester never reached — 047's T023 compared
    // three counts over an empty table and called them equal at 0, 0, 0.
    const slotTs = await settle(res.requestId);
    expect(slotTs, "the slot request never reached the request log").not.toBeNull();
    expect(await requestsAfter(env.id, slotTs!)).toBe(0);

    const put = await fetch(res.body.upload_url!, {
      method: "PUT",
      body: "hello from a client that never touched relay",
    });
    expect(put.status).toBe(200);

    // AND A QUIET WINDOW, TAKEN AFTER THE ARRIVAL WAIT AND NOT INSTEAD OF IT. Arrival is a
    // condition and absence is not: the row above was polled for, and this one is a claim
    // that nothing shows up, which only a wait can support. The ingester's flush is 2 s
    // (DR-11), so five seconds is two flushes and change.
    await new Promise((r) => setTimeout(r, 5_000));

    // SC-001. A byte through the api would be a second row for this tenant; the upload is
    // a request to the STORE, on a different port, and the api never sees it. Scoped by
    // `ts` rather than by a before/after count, because the three slot calls above are
    // still in flight when this test starts and a delta would count them.
    expect(await requestsAfter(env.id, slotTs!)).toBe(0);
    // 60 s, AND THE DEFAULT IS 5. Vitest's per-test budget is 5,000 ms here, so a poll
    // written to a 20-second deadline is killed four times before its own deadline can
    // fire — the generous number is decoration. `request-log.itest.ts` has carried that
    // shape since chapter 4.4 (056-4). This test's waits alone are 5 s of quiet window
    // plus up to 20 s of polling.
  }, 60_000);
});
