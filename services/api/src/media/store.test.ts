import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureBucket, storeConfig, storeReachable, type StoreConfig } from "./store";

// THE TWO CALLS THE API MAKES TO THE STORE, AGAINST A SERVER THAT ANSWERS WHAT IT IS
// TOLD TO.
//
// NOT A MOCK OF THE CLIENT — there is no client. Both functions are `fetch` against a
// signed URL, so the only way to drive their unhappy arms is a real server giving real
// answers. `presign.itest.ts` beside this file asks MinIO the same questions and gets
// the real ones; this file asks what happens when the answer is something MinIO would
// never say, which is the half a running store cannot produce on demand.

describe("the store client, against a server that answers to order", () => {
  let server: Server;
  let config: StoreConfig;
  let reply: { status: number; body: string } = { status: 200, body: "" };
  let seen: { method: string; url: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "" });
      res.statusCode = reply.status;
      res.end(reply.body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    config = { ...storeConfig(), endpoint: `http://127.0.0.1:${port}` };
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reads a 200 as created", async () => {
    reply = { status: 200, body: "" };
    seen = [];
    expect(await ensureBucket(config)).toBe("created");
    // A PUT ON THE BUCKET, not on an object: the canonical URI differs and the signature
    // is computed over it, which is the distinction the first probe of this chapter
    // missed by creating a bucket with `mkdir`.
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.url.split("?")[0]).toBe(`/${config.bucket}`);
  });

  it("reads the store's own name for the second attempt as exists", async () => {
    // 409 `BucketAlreadyOwnedByYou` is what makes running this on every boot safe: the
    // store distinguishes "already there" from "went wrong", so no flag has to.
    reply = { status: 409, body: "<Error><Code>BucketAlreadyOwnedByYou</Code></Error>" };
    expect(await ensureBucket(config)).toBe("exists");
  });

  it("throws on anything else, and carries the status and the body into the message", async () => {
    // THE ARM A RUNNING STORE CANNOT BE ASKED FOR. A 403 here means the credentials are
    // wrong, which is a store the api will fail against on every slot request — failing
    // at boot is the loud version, and it has to say enough to diagnose.
    reply = { status: 403, body: "<Error><Code>SignatureDoesNotMatch</Code></Error>" };
    await expect(ensureBucket(config)).rejects.toThrow(/HTTP 403/);
    await expect(ensureBucket(config)).rejects.toThrow(/SignatureDoesNotMatch/);

    // And a 409 that is NOT the name: another tenant of the same store owns the bucket,
    // which is fatal rather than idempotent. Matching on the status alone would read
    // this as "already ours".
    reply = { status: 409, body: "<Error><Code>BucketAlreadyExists</Code></Error>" };
    await expect(ensureBucket(config)).rejects.toThrow(/HTTP 409/);
  });

  it("calls a 2xx reachable and everything else not", async () => {
    reply = { status: 200, body: "" };
    expect(await storeReachable(config)).toBe(true);

    // A STORE THAT ANSWERS AND REFUSES IS NOT REACHABLE FOR THIS PURPOSE. A 403 on a
    // signed HEAD means the api's credentials no longer work, and issuing slots against
    // it would hand clients URLs the store will reject.
    reply = { status: 403, body: "" };
    expect(await storeReachable(config)).toBe(false);

    reply = { status: 500, body: "" };
    expect(await storeReachable(config)).toBe(false);
  });

  it("calls a refused connection not reachable, rather than throwing", async () => {
    // PORT 1 IS PRIVILEGED AND UNBINDABLE, so the kernel refuses. `storeReachable`'s
    // whole contract is that it answers rather than raises: a slot request must end in
    // a 503 the client can read, not in an unhandled `TypeError: fetch failed` that the
    // error filter turns into `internal_error`.
    expect(await storeReachable({ ...config, endpoint: "http://127.0.0.1:1" })).toBe(false);
  });

  it("gives every field of the config a default, and lets the environment override it", () => {
    const from = storeConfig({ RELAY_MINIO_ENDPOINT: "http://elsewhere:9100" });
    expect(from.endpoint).toBe("http://elsewhere:9100");
    // THE OTHER THREE FALL BACK, which is the case a test that passes a full object
    // never exercises — and a missing default here is a slot request signed with
    // `undefined` as the key.
    expect(from.accessKey).toBe("relay");
    expect(from.secretKey).toBe("relay-secret");
    expect(from.bucket).toBe("relay-media");
    expect(storeConfig({}).endpoint).toBe("http://localhost:9100");
  });
});
