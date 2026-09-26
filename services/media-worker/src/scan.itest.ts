import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "@relay/service-kit";

import { createApiClient, type ApiClient } from "./api-client.js";
import { pngOf } from "./fixtures.js";
import {
  scan,
  scannerConfigFromEnv,
  version,
  type ScannerConfig,
} from "./scan.js";
import { sign, storeConfigFromEnv, type StoreConfig } from "./store.js";
import { sweepOnce } from "./sweep.js";

// FR-MED-04, AGAINST A SCANNER THAT IS ACTUALLY RUNNING.
//
// A test that mocks the scanner asserts that the mock was called. Every finding this
// chapter publishes about ClamAV — that EICAR plus two hundred spaces is `OK`, that a
// trailing newline changes which signature fires, that a thirteen-day-old database
// detects EICAR exactly as a current one does — is unavailable from a stub, because
// each is a fact about the engine rather than about the protocol.

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const API_DIST = join(REPO, "services", "api", "dist");

const WORKER_CREDENTIAL = "rk_svc_media_worker_scan_itest_012345678";

/** The 68 bytes, unpadded. Assembled rather than pasted whole so this file is not
 * itself quarantined by a scanner watching the repository — which is a real thing that
 * happens to source trees containing the literal. */
const EICAR = new TextEncoder().encode(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE" + "!$H+H*",
);

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

describe("a virus is rejected, by a scanner that is running", () => {
  let api: ChildProcess;
  let apiUrl: string;
  let client: ApiClient;
  let store: StoreConfig;
  let scanner: ScannerConfig;
  let apiKey: string;
  let environmentId: string;
  let pool: {
    end: () => Promise<void>;
    query: (q: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
  const logger = createLogger("scan-itest", () => {});

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

  const put = async (url: string, bytes: Uint8Array): Promise<void> => {
    const res = await fetch(url, {
      method: "PUT",
      body: bytes.slice() as unknown as BodyInit,
    });
    expect(res.status, "the presigned PUT was refused").toBe(200);
  };

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
      "select state, object_key, verified_bytes, rejected_reason " +
        "from media_objects where id = $1",
      [id],
    );
    return r.rows[0]!;
  };

  const sweepFor = async (
    id: string,
    over: { scanner?: ScannerConfig } = {},
  ): Promise<void> => {
    await backdate(id);
    await sweepOnce({
      api: client,
      store,
      logger,
      batch: 1,
      scanner: over.scanner ?? scanner,
    });
  };

  const storeHas = async (key: string): Promise<boolean> =>
    (
      await fetch(sign(store, { method: "HEAD", key, expiresIn: 60 }), {
        method: "HEAD",
      })
    ).ok;

  beforeAll(async () => {
    store = storeConfigFromEnv({
      RELAY_MINIO_ENDPOINT: "http://localhost:9100",
      ...process.env,
    });
    scanner = scannerConfigFromEnv(process.env);

    const client_ = require_(join(API_DIST, "db", "client.js")) as {
      createPool: () => typeof pool;
      createDb: (p: unknown) => unknown;
    };
    const seeder = require_(join(API_DIST, "db", "repository.js")) as {
      createEnvironment: (db: unknown, o: { name: string }) => Promise<{ id: string }>;
      createApiKey: (
        db: unknown,
        o: { environmentId: string },
      ) => Promise<{ credential: string }>;
    };
    pool = client_.createPool();
    const db = client_.createDb(pool);
    environmentId = (
      await seeder.createEnvironment(db, {
        name: `scan-itest-${randomUUID().slice(0, 8)}`,
      })
    ).id;
    apiKey = (await seeder.createApiKey(db, { environmentId })).credential;

    const port = 14_714;
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
    await pool?.query("delete from media_objects where environment_id = $1", [
      environmentId,
    ]);
    await pool?.end();
  });

  it("THE CONTROL: the scanner itself finds EICAR (T040a)", async () => {
    // WITHOUT THIS, A GREEN `scan_failed` COULD COME FROM A SCANNER THAT REFUSED
    // EVERYTHING. The platform's verdict and the engine's answer are two claims, and
    // the suite asserts the second one directly so the first cannot stand on a
    // misconfiguration. 4.12's gauntlet needed the same control one layer up.
    const result = await scan(scanner, EICAR);
    expect(result).toMatchObject({ outcome: "infected" });
    expect((result as { signature: string }).signature).toContain("Eicar");
  });

  it("and the counter-control: a real PNG is clean", async () => {
    // A scanner that answered `FOUND` to everything would pass the test above.
    expect(await scan(scanner, pngOf(32, 32))).toEqual({ outcome: "clean" });
  });

  it("reports which signature database it is scanning against", async () => {
    // Logged at boot and asserted here, because the figure is the subject of this
    // chapter's health-check argument: `ClamAV <engine>/<db version>/<build date>`,
    // and only the third field carries the fact a liveness probe cannot.
    const line = await version(scanner);
    expect(line).toMatch(/ClamAV \d+\.\d+\.\d+\/\d+\//);
  });

  it("REJECTS AN INFECTED OBJECT: rejected, scan_failed, bytes gone (SC-003)", async () => {
    const { id, url } = await slot("image/png", EICAR.length);
    await put(url, EICAR);
    const key = (await rowOf(id))["object_key"] as string;
    expect(await storeHas(key)).toBe(true);

    await sweepFor(id);

    const row = await rowOf(id);
    expect(row["state"]).toBe("rejected");
    expect(row["rejected_reason"]).toBe("scan_failed");
    expect(await storeHas(key)).toBe(false);
  });

  it("AND THE SCAN RUNS FIRST, so an object wrong on BOTH reports scan_failed (T039b)", async () => {
    // `scan_failed` wins. It is the more serious fact about the caller, and a
    // mis-declared infected file filed as `declaration_mismatch` would be a count that
    // understates the thing being counted.
    //
    // THE DECLARATION HERE IS WRONG TWICE: the slot says `image/png` at a size that is
    // not EICAR's length, and the bytes are not a PNG. Under the other order this
    // would answer `declaration_mismatch` and the object would never be scanned.
    const { id, url } = await slot("image/png", EICAR.length + 99);
    await put(url, EICAR);
    await sweepFor(id);

    const row = await rowOf(id);
    expect(row["state"]).toBe("rejected");
    expect(row["rejected_reason"]).toBe("scan_failed");
  });

  it("A SCANNER THAT IS UNREACHABLE LEAVES THE OBJECT PENDING (FR-009)", async () => {
    // NOT `rejected`, which would destroy a customer's bytes on the strength of an
    // outage; not `ready`, which would let an unscanned object through. There is no
    // `retry` verdict, so the worker records nothing at all.
    //
    // THE ADDRESS IS WRONG, NOT THE CONTAINER (056-5). `docker compose stop clamav` is
    // the truest test and it is an action scoped wider than its own test — the lane
    // runs two files at a time and 4.10's version of this made `gauntlet.itest.ts`
    // answer 503 in a file that never mentions media. Port 1 is refused by the kernel
    // and belongs to nobody.
    //
    // AND IT IS WRONG AT THE MOMENT OF THE REQUEST, not at the moment of the wiring —
    // 4.10's second finding, where a second Nest app answered 201 because the service
    // was request-scoped. `sweepOnce` takes the config per call.
    const png = pngOf(40, 40);
    const { id, url } = await slot("image/png", png.length);
    await put(url, png);

    await sweepFor(id, { scanner: { host: "127.0.0.1", port: 1 } });
    expect((await rowOf(id))["state"]).toBe("pending");

    // BOTH HALVES, because only the second proves the first was a PAUSE rather than a
    // silent drop. An object the worker skipped forever and an object it will come
    // back to look identical after one sweep.
    await sweepFor(id);
    expect((await rowOf(id))["state"]).toBe("ready");
  });

  it("and the bytes survive the outage, because nothing was decided", async () => {
    const png = pngOf(24, 24);
    const { id, url } = await slot("image/png", png.length);
    await put(url, png);
    const key = (await rowOf(id))["object_key"] as string;

    await sweepFor(id, { scanner: { host: "127.0.0.1", port: 1 } });
    expect(await storeHas(key), "an outage deleted a customer's bytes").toBe(true);
  });

  it("A SCANNER THAT ANSWERS NONSENSE IS ALSO AN OUTAGE, not a clean bill", async () => {
    // Pointed at a port that accepts and says something that is not the protocol —
    // the api's own health endpoint. The reply parses as nothing, and the worker must
    // read that as "could not tell" rather than as "nothing found".
    const png = pngOf(20, 20);
    const { id, url } = await slot("image/png", png.length);
    await put(url, png);

    await sweepFor(id, {
      scanner: { host: "127.0.0.1", port: 14_714, timeoutMs: 3_000 },
    });
    expect((await rowOf(id))["state"]).toBe("pending");
  });
});
