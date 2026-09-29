import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bucketPresent,
  getObject,
  headObject,
  putObject,
  sign,
  storeConfigFromEnv,
  type StoreConfig,
} from "./store.js";

const store: StoreConfig = {
  endpoint: "http://minio:9000",
  accessKey: "relay",
  secretKey: "relay-secret",
  bucket: "relay-media",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the worker's own address book", () => {
  it("REFUSES TO START WITH NO STORE ADDRESS, rather than defaulting to localhost", () => {
    // 4.11 measured what the default costs: `store.ts` fell back to
    // `http://localhost:9100`, which inside a container is that container, and the
    // composed api answered 503 to every slot request for a chapter. A worker with no
    // store address has nothing to verify, so it says so at boot instead of sweeping
    // an empty backlog forever.
    expect(() => storeConfigFromEnv({})).toThrow(/must be set/);
  });

  it("prefers the internal address, because that is the one it can reach", () => {
    const config = storeConfigFromEnv({
      RELAY_MINIO_ENDPOINT: "http://localhost:9100",
      RELAY_MINIO_INTERNAL_ENDPOINT: "http://minio:9000",
    });
    expect(config.endpoint).toBe("http://minio:9000");
  });

  it("falls back to the public address when there is only one", () => {
    // Every host-process lane sets one address, and the two are the same there.
    const config = storeConfigFromEnv({
      RELAY_MINIO_ENDPOINT: "http://localhost:9100",
    });
    expect(config.endpoint).toBe("http://localhost:9100");
  });
});

describe("the signature", () => {
  it("is a function of the instant, so two are different", () => {
    const a = sign(store, {
      method: "HEAD",
      key: "o/1",
      now: new Date("2026-09-26T12:00:00Z"),
    });
    const b = sign(store, {
      method: "HEAD",
      key: "o/1",
      now: new Date("2026-09-26T13:00:00Z"),
    });
    expect(a).not.toBe(b);
  });

  it("puts the BUCKET in the path and no key segment when there is no key", () => {
    // A bucket operation is a different canonical URI from a key operation — `/bucket`
    // with no trailing slash. The first probe of 4.10 created its bucket with `mkdir`
    // and so never exercised this path.
    const url = new URL(sign(store, { method: "HEAD" }));
    expect(url.pathname).toBe("/relay-media");
  });

  it("encodes a key's segments and keeps the separators", () => {
    const url = new URL(sign(store, { method: "GET", key: "env/a b.png" }));
    expect(url.pathname).toBe("/relay-media/env/a%20b.png");
  });

  it("signs GET and HEAD differently — the method is inside the signature", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    const get = new URL(sign(store, { method: "GET", key: "k", now }));
    const head = new URL(sign(store, { method: "HEAD", key: "k", now }));
    expect(get.searchParams.get("X-Amz-Signature")).not.toBe(
      head.searchParams.get("X-Amz-Signature"),
    );
  });
});

describe("what the store says about an object", () => {
  const respond = (status: number, headers: Record<string, string> = {}) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status, headers })),
    );

  it("answers null for a 404, which is 'not uploaded yet'", async () => {
    respond(404);
    expect(await headObject(store, "k")).toBeNull();
  });

  it("reports the store's own count, not the client's claim", async () => {
    respond(200, { "content-length": "4096", "content-type": "image/png" });
    const head = await headObject(store, "k");
    expect(head?.bytes).toBe(4096);
    // CARRIED, AND NOT EVIDENCE. `content-type` on a presigned PUT is whatever the
    // client sent — measured: twelve MP4 bytes uploaded as `image/png` answer HEAD
    // with `image/png`. The chapter shows that rather than trusting it.
    expect(head?.declaredType).toBe("image/png");
  });

  it("reads last-modified, which is where SC-006's clock starts", async () => {
    respond(200, {
      "content-length": "1",
      "last-modified": "Sun, 20 Sep 2026 17:02:53 GMT",
    });
    const head = await headObject(store, "k");
    expect(head?.lastModified?.toISOString()).toBe("2026-09-20T17:02:53.000Z");
  });

  it("answers null for last-modified rather than an Invalid Date", async () => {
    // A store that sends no such header would otherwise produce `new Date(null)`,
    // which is the epoch — a plausible-looking instant that is a fabrication.
    respond(200, { "content-length": "1" });
    expect((await headObject(store, "k"))?.lastModified).toBeNull();
  });

  it("throws on any other status, because it is not a fact about the object", async () => {
    respond(503);
    await expect(headObject(store, "k")).rejects.toThrow(/503/);
  });
});

describe("the bucket probe", () => {
  it("is false when the store cannot be reached at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect(await bucketPresent(store)).toBe(false);
  });

  it("is false for a 404, which is a bucket that is not there", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    expect(await bucketPresent(store)).toBe(false);
  });

  it("is true for a 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    expect(await bucketPresent(store)).toBe(true);
  });
});

// THE FOURTH READER AND THE FIRST WRITER (chapter 4.15).
//
// This service had four readers and no writer until FR-MED-05 needed one. `getObject`
// is the only call that holds a whole object: `streamObject` hands the scanner 64 KiB at
// a time because the largest allowed object is 100 MB, and a rendition cannot be made
// from a stream that has already been consumed.
describe("fetching a whole object to render", () => {
  const respond = (status: number, body?: BodyInit, headers: HeadersInit = {}) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body ?? null, { status, headers })));

  it("returns the bytes", async () => {
    respond(200, new Uint8Array([1, 2, 3, 4]), { "content-length": "4" });
    const out = await getObject(store, "k/1", 1024);
    expect(out).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("answers null for a 404, the same absence headObject gives", async () => {
    respond(404);
    expect(await getObject(store, "k/1", 1024)).toBeNull();
  });

  it("throws on any other refusal rather than returning empty bytes", async () => {
    respond(503);
    await expect(getObject(store, "k/1", 1024)).rejects.toThrow("503");
  });

  it("refuses an object larger than the caller will hold", async () => {
    // NOT DEFENSIVENESS — the 1.4x RSS ratio applied. The caller is the image path,
    // where FR-MED-02 caps an object at 10 MB, so a `content-length` above the cap means
    // the row and the store disagree and buffering it would spend memory on a number
    // this function could have read first.
    respond(200, new Uint8Array(8), { "content-length": "99999999" });
    await expect(getObject(store, "k/1", 1024)).rejects.toThrow("exceeds");
  });
});

describe("writing a rendition to the store", () => {
  it("PUTs the bytes and reports success", async () => {
    const seen: { method?: string; type?: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push({
          method: init.method,
          type: new Headers(init.headers).get("content-type"),
        });
        return new Response(null, { status: 200 });
      }),
    );
    expect(await putObject(store, "k/thumb", new Uint8Array([1, 2]), "image/webp")).toBe(true);
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.type).toBe("image/webp");
  });

  it("reports failure rather than throwing when the store refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    expect(await putObject(store, "k/thumb", new Uint8Array([1]), "image/webp")).toBe(false);
  });

  it("reports failure when the store cannot be reached at all", async () => {
    // A rendition that could not be written must become a recorded reason on the parent,
    // not an exception that kills the sweep for every object behind it.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await putObject(store, "k/thumb", new Uint8Array([1]), "image/webp")).toBe(false);
  });

  it("signs a PUT, which this signer could not do before 4.15", () => {
    const url = sign(store, { method: "PUT", key: "k/thumb" });
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("relay-media/k/thumb");
  });
});
