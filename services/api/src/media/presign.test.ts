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
    expect(
      presign({ ...base, method: "PUT", key: "a/b.txt", now: later }),
    ).not.toBe(presign({ ...base, method: "PUT", key: "a/b.txt" }));
  });

  it("puts a BUCKET operation at /{bucket} with no key segment", () => {
    // The different canonical URI, which is the half the chapter's first probe skipped
    // by creating its bucket with `mkdir`.
    expect(new URL(presign({ ...base, method: "PUT" })).pathname).toBe(
      "/relay-media",
    );
  });

  it("encodes a key segment by segment, keeping the separators", () => {
    const url = new URL(
      presign({ ...base, method: "PUT", key: "a b/c+d.txt" }),
    );
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

  // ── CHAPTER 4.16: EXTRA SIGNED PARAMETERS ──────────────────────────────────────
  //
  // **EVERY PARAMETER MUST BE INSIDE THE SIGNATURE**, measured against MinIO before the
  // argument existed: appending `&list-type=2` to an already-signed URL answers
  // `SignatureDoesNotMatch`. So a bucket listing that needs pagination cannot bolt its
  // `marker` on afterwards, and the ordering stopped being a thing five hand-written
  // entries could guarantee.

  it("sorts every signed parameter, whichever side of X-Amz- it falls", () => {
    // BOTH DIRECTIONS THROUGH THE COMPARATOR IN ONE CALL. `list-type` sorts BEFORE
    // `marker` and both sort AFTER every `X-Amz-*`, because uppercase precedes lowercase
    // in ASCII — and `0-offset` sorts before all of them, which is the case the
    // hand-written order would have got wrong and the reason this is a sort at all.
    const url = new URL(
      presign({
        ...base,
        method: "GET",
        params: { marker: "m", "list-type": "2", "0-offset": "x" },
      }),
    );
    const names = [...url.searchParams.keys()].filter(
      (k) => k !== "X-Amz-Signature",
    );
    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe("0-offset");
    expect(names.slice(-2)).toEqual(["list-type", "marker"]);
  });

  it("signs them: the same URL with a parameter changed is a different signature", () => {
    const a = new URL(
      presign({ ...base, method: "GET", params: { marker: "a" } }),
    );
    const b = new URL(
      presign({ ...base, method: "GET", params: { marker: "b" } }),
    );
    expect(a.searchParams.get("X-Amz-Signature")).not.toBe(
      b.searchParams.get("X-Amz-Signature"),
    );
    // And a call with no parameters is unchanged by the argument existing — the listing
    // is the only caller, and every other signed URL in the platform predates it.
    const bare = new URL(presign({ ...base, method: "GET", key: "a.txt" }));
    const same = new URL(
      presign({ ...base, method: "GET", key: "a.txt", params: {} }),
    );
    expect(bare.toString()).toBe(same.toString());
  });

  it("keeps a caller's duplicate of a signed name in one stable order", () => {
    // THE COMPARATOR'S THIRD ARM, AND IT IS REACHABLE FROM OUTSIDE. A caller passing a
    // parameter the signer already writes gives the sort two equal keys; the answer is a
    // URL the store will refuse, and what this pins is that it is the SAME refusal every
    // time rather than one that depends on the sort's internals.
    const once = presign({
      ...base,
      method: "GET",
      params: { "X-Amz-Expires": "60" },
    });
    expect(
      presign({ ...base, method: "GET", params: { "X-Amz-Expires": "60" } }),
    ).toBe(once);
    expect(once.match(/X-Amz-Expires/g)).toHaveLength(2);
  });
});
