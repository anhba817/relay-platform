import { createHash, createHmac } from "node:crypto";

// THE WORKER SIGNS ITS OWN READS, AND THE ALTERNATIVE WAS WORSE.
//
// This is `services/api/src/media/presign.ts`, copied — twenty-eight lines of SigV4 and
// no dependency. The three alternatives, named because copying code is the kind of
// decision that should be argued rather than drifted into:
//
//   ASK THE API TO SIGN        a fourth internal route whose response is a URL granting
//                              read access to a customer's bytes. ADR-14's gate exists
//                              to stop signed URLs escaping; minting them for a caller
//                              is the thing it forbids, and the caller happens to be
//                              trusted today.
//   A SHARED PACKAGE           `packages/media-signing`. Correct, and it moves a file
//                              the tutorial publishes whole at 4.10 into a new package,
//                              which rewrites that chapter's fences for a refactor
//                              4.13 does not need.
//   THE AWS SDK                ADR-30 rejected it for two calls; this is two more.
//
// So: copied, with the divergence stated. If a third caller appears, the package is the
// answer and this comment is the record of why it was not the answer at two.
//
// WHAT IS NOT COPIED IS THE CONFIG. The api's `storeConfig` reads its own defaults; this
// one refuses to start without an explicit endpoint, because a worker that silently
// falls back to `localhost` inside a container is 4.11's 503 — measured, and the reason
// `RELAY_MINIO_INTERNAL_ENDPOINT` exists at all.

function signingKey(secret: string, date: string, region: string): Buffer {
  let key: Buffer | string = `AWS4${secret}`;
  for (const part of [date, region, "s3", "aws4_request"]) {
    key = createHmac("sha256", key).update(part).digest();
  }
  return key as Buffer;
}

export interface StoreConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

export function storeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StoreConfig {
  const endpoint =
    env["RELAY_MINIO_INTERNAL_ENDPOINT"] ?? env["RELAY_MINIO_ENDPOINT"];
  if (!endpoint) {
    throw new Error(
      "RELAY_MINIO_INTERNAL_ENDPOINT or RELAY_MINIO_ENDPOINT must be set: " +
        "a media worker with no store address has nothing to verify",
    );
  }
  return {
    endpoint,
    accessKey: env["RELAY_MINIO_ACCESS_KEY"] ?? "relay",
    secretKey: env["RELAY_MINIO_SECRET_KEY"] ?? "relay-secret",
    bucket: env["RELAY_MINIO_BUCKET"] ?? "relay-media",
  };
}

export interface SignOptions {
  /** `"PUT"` ARRIVED WITH CHAPTER 4.15 AND THE NARROWER TYPE WAS RIGHT UNTIL THEN.
   * This service read what a client uploaded and produced nothing, so a signer that
   * could not sign a write was a true statement about the worker rather than a
   * limitation — the compiler refused `putObject` before a reviewer could. Widened
   * deliberately, with the reason, because the next person to see three verbs here
   * should know the third one is FR-MED-05's and not a convenience. */
  method: "GET" | "HEAD" | "PUT";
  key?: string;
  expiresIn?: number;
  now?: Date;
}

export function sign(config: StoreConfig, options: SignOptions): string {
  const { method, key = "", expiresIn = 300, now = new Date() } = options;
  const region = config.region ?? "us-east-1";
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const host = new URL(config.endpoint).host;
  const credential = `${config.accessKey}/${date}/${region}/s3/aws4_request`;

  const canonicalUri = key
    ? `/${config.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`
    : `/${config.bucket}`;
  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  });
  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${date}/${region}/s3/aws4_request`,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const signature = createHmac(
    "sha256",
    signingKey(config.secretKey, date, region),
  )
    .update(stringToSign)
    .digest("hex");

  return `${config.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** What the store says about an object it holds.
 *
 * `null` MEANS NOT THERE YET, and that is FR-009 expressed as an absence. A `HEAD` for
 * an absent key and a `HEAD` for an absent BUCKET both answer 404 — measured, because a
 * HEAD carries no body to distinguish them — so this cannot tell "the client has not
 * uploaded" from "the store has no bucket". `bucketPresent` below is the cheap question
 * that can, asked once per sweep rather than once per object. */
export interface ObjectHead {
  bytes: number;
  /** The store's own `content-type`, which is the CLIENT's claim echoed back and is
   * therefore not evidence of anything. Carried so the chapter can show that. */
  declaredType: string | null;
  /** WHERE SC-006's CLOCK STARTS. Nothing tells this platform when a PUT finished —
   * the client uploads to the store directly (ADR-13) — so the only observation of
   * that instant is this header, at one-second resolution because an HTTP date has no
   * sub-second field. */
  lastModified: Date | null;
}

export async function headObject(
  config: StoreConfig,
  key: string,
  timeoutMs = 5_000,
): Promise<ObjectHead | null> {
  const res = await fetch(sign(config, { method: "HEAD", key }), {
    method: "HEAD",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HEAD ${key}: ${res.status}`);
  const modified = res.headers.get("last-modified");
  return {
    bytes: Number(res.headers.get("content-length") ?? 0),
    declaredType: res.headers.get("content-type"),
    lastModified: modified ? new Date(modified) : null,
  };
}

/** ONCE PER SWEEP, NOT ONCE PER OBJECT. A missing bucket answers every object's `HEAD`
 * with 404, which the sweep reads as *"not uploaded yet"* — so a bucketless store makes
 * the worker inert and silent, which is 056-10's condition one chapter on. */
export async function bucketPresent(
  config: StoreConfig,
  timeoutMs = 5_000,
): Promise<boolean> {
  try {
    const res = await fetch(sign(config, { method: "HEAD" }), {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The first `n` bytes, for the type and dimension probes.
 *
 * `Range` RIDES UNSIGNED, which is what makes this cheap. The signature covers the
 * method, the path, the query and the `host` header only — `X-Amz-SignedHeaders: host`
 * — so a ranged GET uses the same signature a whole GET would, and the store answers
 * **206** with a `content-range` of its own. Measured against MinIO: `bytes 0-7/12`.
 *
 * A 200 IS NOT A FAILURE. A store that ignores `Range` sends the whole object, and for
 * an object under `n` bytes that is the same thing — so the body is truncated here
 * rather than the response refused. What would be wrong is trusting the length. */
export async function getRange(
  config: StoreConfig,
  key: string,
  n: number,
  timeoutMs = 30_000,
): Promise<Uint8Array | null> {
  const res = await fetch(sign(config, { method: "GET", key }), {
    method: "GET",
    headers: { range: `bytes=0-${n - 1}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${key}: ${res.status}`);
  return new Uint8Array((await res.arrayBuffer()).slice(0, n));
}

/** The whole object, as chunks, for the scanner.
 *
 * AN ASYNC ITERABLE AND NOT A BUFFER, because the largest allowed object is 100 MB and
 * `arrayBuffer()` on one costs **142.7 MB of RSS** — measured, 1.4× the object, since
 * the copy and the original are both live. The worker holds one chunk at a time.
 *
 * `null` MEANS THE OBJECT IS NOT THERE, the same answer `headObject` gives, so a caller
 * that raced FR-MED-10's reap gets an absence rather than an exception. */
export async function streamObject(
  config: StoreConfig,
  key: string,
  timeoutMs = 120_000,
): Promise<AsyncIterable<Uint8Array> | null> {
  const res = await fetch(sign(config, { method: "GET", key, expiresIn: 600 }), {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok || !res.body) throw new Error(`GET ${key}: ${res.status}`);
  return res.body as unknown as AsyncIterable<Uint8Array>;
}

/** The whole object, buffered — the fourth call this worker makes to the store, and the
 * first that holds an object in memory.
 *
 * **WHY A FOURTH CALL AND NOT A REUSE OF THE THIRD.** `streamObject` hands ClamAV an
 * `AsyncIterable` which the scan consumes once; a stream cannot be read twice, and the
 * comment above it explains why it is a stream rather than a buffer — 100 MB objects at
 * 1.4× RSS. `getRange` takes 64 KiB for the probe. So a rendition needs bytes nothing
 * currently holds, and `research.md` R9 is the argument for paying a round trip rather
 * than teeing the scan (which would buffer every video) or buffering once up front
 * (which would do it before anything knows the object is an image).
 *
 * **`maxBytes` IS NOT DEFENSIVENESS, IT IS THE 1.4× RATIO APPLIED.** The caller is the
 * image path, where FR-MED-02 caps an object at 10 MB; a `content-length` that exceeds
 * the cap means the row and the store disagree, and buffering it would be spending
 * memory on the strength of a number this function could have checked first.
 *
 * `null` for a missing object, matching `headObject` and `streamObject`, so a caller that
 * raced a deletion gets an absence rather than an exception. */
export async function getObject(
  config: StoreConfig,
  key: string,
  maxBytes: number,
  timeoutMs = 60_000,
): Promise<Uint8Array | null> {
  const res = await fetch(sign(config, { method: "GET", key, expiresIn: 600 }), {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${key}: ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new Error(`GET ${key}: ${declared} bytes exceeds ${maxBytes}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Put bytes into the store — **the first write this service has ever made.**
 *
 * Before this the worker had four readers and no writer: `headObject`, `bucketPresent`,
 * `getRange` and `streamObject`. That asymmetry was the shape of the service, not an
 * oversight — it reads what a client uploaded and tells the api what it found. A
 * rendition is the first thing it produces.
 *
 * **THE HOST IS INSIDE THE SIGNATURE** (4.11), which is why this signs against
 * `internalEndpoint` like `deleteObject` in the api does: the worker's address for the
 * store and a client's are different strings and cannot be one field.
 *
 * `content-type` IS SENT AND IS NOT EVIDENCE. The store echoes whatever it is told —
 * 4.13 measured twelve MP4 bytes sent as `image/png` answering `HEAD` with `image/png` —
 * so this sets it for a client's benefit on delivery and nothing downstream trusts it. */
export async function putObject(
  config: StoreConfig,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const url = sign(config, { method: "PUT", key, expiresIn: 600 });
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": contentType },
      // `Buffer.from` rather than the Uint8Array itself: `BodyInit` does not admit
      // `Uint8Array<ArrayBufferLike>` under this lib, and a cast would hide that the
      // conversion is a view rather than a copy.
      // A COPY, AND IT IS CHEAPER THAN THE CAST IT REPLACES. `BodyInit` wants a view
      // over a plain `ArrayBuffer`, and what arrives here is `Uint8Array<ArrayBufferLike>`
      // — TypeScript 5.7 separated those, and a `SharedArrayBuffer`-backed view really
      // cannot be sent. `new Uint8Array(bytes)` copies into a fresh buffer; a thumbnail
      // is single-digit kilobytes, so the copy is free and the alternative is an
      // `as unknown as BodyInit` that would be wrong for one real input.
      body: new Blob([new Uint8Array(bytes)]),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
