import { beforeAll, describe, expect, it } from "vitest";

import { presign } from "./presign";
import { ensureBucket, storeConfig } from "./store";

// THE NINE RESULTS, ASKED OF A RUNNING STORE.
//
// Determinism is not correctness: `presign.test.ts` proves the URL has a stable shape,
// and a consistently wrong signature passes every assertion in it. Only the store can
// say whether the canonical request is right, and its answer to a wrong one is a bare
// 400 with no indication of which field was wrong.
//
// FOUR OF THESE ARE ABOUT THE BUCKET, which the chapter's first probe skipped by
// creating one with `mkdir`. A bucket operation has a different canonical URI.

const config = storeConfig();
const url = (over: Partial<Parameters<typeof presign>[0]> = {}) =>
  presign({ method: "PUT", ...config, ...over });

describe("the signer, against the store", () => {
  beforeAll(async () => {
    await ensureBucket(config);
  });

  it("creates the bucket, and says so the second time", async () => {
    expect(await ensureBucket(config)).toBe("exists");
  });

  it("answers a signed HEAD on the bucket", async () => {
    const res = await fetch(url({ method: "HEAD" }), { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  it("refuses an unsigned LIST of the bucket", async () => {
    const res = await fetch(`${config.endpoint}/${config.bucket}/`);
    expect(res.status).toBe(403);
  });

  it("accepts an upload with no credentials on the request", async () => {
    const res = await fetch(url({ key: "probe/hello.txt" }), {
      method: "PUT",
      body: "hello from a client that never touched relay",
    });
    expect(res.status).toBe(200);
  });

  it("reads the same bytes back through a signed GET", async () => {
    const res = await fetch(url({ method: "GET", key: "probe/hello.txt" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from a client that never touched relay");
  });

  it("refuses an unsigned GET of that object — FR-MED-08's precondition", async () => {
    const res = await fetch(`${config.endpoint}/${config.bucket}/probe/hello.txt`);
    expect(res.status).toBe(403);
  });

  it("refuses a URL whose expiry has passed, from the store's own clock", async () => {
    const past = new Date(Date.now() - 60_000);
    const res = await fetch(url({ key: "probe/old.txt", expiresIn: 1, now: past }), {
      method: "PUT",
      body: "late",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Request has expired");
  });

  it("refuses a URL with one character of the signature changed", async () => {
    // 403 `SignatureDoesNotMatch`, NOT the 400 this chapter's planning published.
    // That 400 was the probe's own: the shell that produced it split the URL on the
    // LAST `?` rather than the first and sent something malformed. Asked through code
    // the store is consistent — a bad signature is a refusal, not a parse error.
    //
    // AND THE MUTATION IS CHECKED, because the first version of this test was a flake
    // one run in sixteen. It replaced the signature's first character with `f`, which
    // is a no-op whenever that character already IS `f` — a signature is 64 hex digits,
    // so the probe sent a VALID url one time in sixteen and the store's honest 200 read
    // as "the store accepted a tampered signature". It passed three consecutive runs
    // before it failed. A probe that may not have altered anything has to say so.
    const signed = url({ key: "probe/tampered.txt" });
    const tampered = signed.replace(/X-Amz-Signature=(.)/, (_m, c: string) =>
      `X-Amz-Signature=${c === "f" ? "0" : "f"}`,
    );
    expect(tampered, "the tamper was a no-op").not.toBe(signed);

    const res = await fetch(tampered, { method: "PUT", body: "nope" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("SignatureDoesNotMatch");
  });

  it("refuses a URL signed with the wrong secret", async () => {
    const wrong = presign({
      method: "PUT",
      ...config,
      secretKey: "not-the-secret",
      key: "probe/wrong.txt",
    });
    const res = await fetch(wrong, { method: "PUT", body: "nope" });
    expect(res.status).toBe(403);
  });
});
