import { describe, expect, it } from "vitest";

import { presign } from "./presign";

// THE SHAPE, PINNED. What this file cannot tell you is whether the store accepts the
// URL — the canonical request is unforgiving and its failure mode is a bare 400, so
// `presign.itest.ts` asks the store and this one asks the algorithm.

const base = {
  endpoint: "http://localhost:9100",
  bucket: "relay-media",
  accessKey: "relay",
  secretKey: "relay-secret",
  now: new Date("2026-09-19T12:00:00.000Z"),
} as const;

describe("a presigned URL", () => {
  it("carries the six signed parameters and no others", () => {
    const url = new URL(presign({ ...base, method: "PUT", key: "a/b.txt" }));
    expect([...url.searchParams.keys()].sort()).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
    ]);
  });

  it("is a function of the instant, so a pinned clock gives a stable signature", () => {
    const a = presign({ ...base, method: "PUT", key: "a/b.txt" });
    const b = presign({ ...base, method: "PUT", key: "a/b.txt" });
    expect(a).toBe(b);
  });

  it("signs a different signature one second later", () => {
    const later = new Date(base.now.getTime() + 1000);
    expect(presign({ ...base, method: "PUT", key: "a/b.txt", now: later })).not.toBe(
      presign({ ...base, method: "PUT", key: "a/b.txt" }),
    );
  });

  it("puts a BUCKET operation at /{bucket} with no key segment", () => {
    // The different canonical URI, which is the half the chapter's first probe skipped
    // by creating its bucket with `mkdir`.
    expect(new URL(presign({ ...base, method: "PUT" })).pathname).toBe("/relay-media");
  });

  it("encodes a key segment by segment, keeping the separators", () => {
    const url = new URL(presign({ ...base, method: "PUT", key: "a b/c+d.txt" }));
    expect(url.pathname).toBe("/relay-media/a%20b/c%2Bd.txt");
  });

  it("defaults to fifteen minutes, which is FR-MED-01's window", () => {
    const url = new URL(presign({ ...base, method: "PUT", key: "a.txt" }));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  });

  it("signs the method, so a GET URL is not a PUT URL", () => {
    const put = new URL(presign({ ...base, method: "PUT", key: "a.txt" }));
    const get = new URL(presign({ ...base, method: "GET", key: "a.txt" }));
    expect(get.searchParams.get("X-Amz-Signature")).not.toBe(
      put.searchParams.get("X-Amz-Signature"),
    );
  });

  it("scopes the credential to the date and region", () => {
    const url = new URL(presign({ ...base, method: "PUT", key: "a.txt" }));
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "relay/20260919/us-east-1/s3/aws4_request",
    );
  });
});
