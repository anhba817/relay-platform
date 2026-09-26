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
  method: "GET" | "HEAD";
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
