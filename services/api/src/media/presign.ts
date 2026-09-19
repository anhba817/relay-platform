import { createHash, createHmac } from "node:crypto";

// SigV4, IN TWENTY-EIGHT LINES AND NO DEPENDENCY.
//
// ADR-13 says media bytes never transit Relay compute: the api brokers access to a
// store it never touches. The broker's whole job is producing this string, and the
// obvious way to produce it is `@aws-sdk/client-s3` plus `@aws-sdk/s3-request-presigner`
// — two packages and a transitive tree for a signature with a published algorithm.
// Chapter 4.2 set the precedent in the other direction: ClickHouse is reached with
// Node's own `fetch` and `apply.mjs` has no driver. ADR-30 carries the argument.
//
// WHAT IT COSTS: the canonical request is unforgiving and its failure mode is a bare
// 400 with no indication of which field was wrong. So the test that matters is the one
// against a running store (`presign.itest.ts`), not one against an expected string.

/** The five HMAC rounds AWS calls a signing key. */
function signingKey(secret: string, date: string, region: string): Buffer {
  let key: Buffer | string = `AWS4${secret}`;
  for (const part of [date, region, "s3", "aws4_request"]) {
    key = createHmac("sha256", key).update(part).digest();
  }
  return key as Buffer;
}

export interface PresignOptions {
  /** `PUT` for an upload or a bucket create, `GET` for a read, `HEAD` to probe. */
  method: "GET" | "PUT" | "HEAD";
  /** Origin only — `http://localhost:9000`. */
  endpoint: string;
  bucket: string;
  /** Empty for a BUCKET operation, which is a different canonical URI: `/{bucket}`
   * with no key segment and no trailing slash. The first probe of this chapter
   * created its bucket with `mkdir` and so never exercised this path. */
  key?: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  /** Seconds. FR-003 says 15 minutes for an upload slot, and the STORE enforces it —
   * a URL past its expiry is refused with `AccessDenied · Request has expired` from
   * the store's own clock, with nothing asked of us. */
  expiresIn?: number;
  /** Injectable for the tests; the signature is a function of this instant. */
  now?: Date;
}

export function presign(options: PresignOptions): string {
  const {
    method,
    endpoint,
    bucket,
    key = "",
    accessKey,
    secretKey,
    region = "us-east-1",
    expiresIn = 900,
    now = new Date(),
  } = options;

  const host = new URL(endpoint).host;
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;

  // ORDER MATTERS AND `URLSearchParams` PRESERVES INSERTION ORDER. The canonical query
  // string is the signed parameters sorted by name, and these five already are.
  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKey}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  });

  // SEGMENT BY SEGMENT. `encodeURIComponent` on the whole path would escape the
  // separators too, and a key with a slash in it is the normal case here.
  const uri = key
    ? `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`
    : `/${bucket}`;

  const canonical = [
    method,
    uri,
    query.toString(),
    `host:${host}\n`,
    "host",
    // The client sends the bytes, so we cannot hash them. This literal is what makes
    // a presigned URL possible at all.
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");

  const signature = createHmac("sha256", signingKey(secretKey, date, region))
    .update(toSign)
    .digest("hex");
  query.set("X-Amz-Signature", signature);

  return `${endpoint}${uri}?${query}`;
}
