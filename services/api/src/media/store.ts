import { presign } from "./presign";

// WHERE THE OBJECT STORE IS, AND THE ONE CALL THE API MAKES TO IT DIRECTLY.
//
// Every other call is made by the CLIENT against a URL this service signs (ADR-13).
// The exception is creating the bucket, which has to happen once before any slot can
// be issued and which nothing else in the stack does.

export interface StoreConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export function storeConfig(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  return {
    endpoint: env.RELAY_MINIO_ENDPOINT ?? "http://localhost:9100",
    accessKey: env.RELAY_MINIO_ACCESS_KEY ?? "relay",
    secretKey: env.RELAY_MINIO_SECRET_KEY ?? "relay-secret",
    bucket: env.RELAY_MINIO_BUCKET ?? "relay-media",
  };
}

/** Create the bucket, or confirm it is already ours.
 *
 * ON BOOT, EVERY BOOT, WITH THE SIGNER THIS MODULE ALREADY HAS. The alternatives were
 * an entrypoint script and a migration-like runner; both add a moving part for one
 * idempotent call. What makes running it unconditionally safe is that the store has a
 * NAME for the second attempt — `BucketAlreadyOwnedByYou`, 409 — rather than a generic
 * failure, so "already there" and "went wrong" are distinguishable without a flag. */
export async function ensureBucket(config: StoreConfig): Promise<"created" | "exists"> {
  const url = presign({ method: "PUT", ...config, expiresIn: 60 });
  const res = await fetch(url, { method: "PUT" });
  if (res.ok) return "created";

  const body = await res.text();
  if (body.includes("BucketAlreadyOwnedByYou")) return "exists";

  // ANYTHING ELSE IS FATAL AND SAYS SO. A store the api cannot write to is a store
  // every slot request will fail against, and failing at boot is the loud version.
  throw new Error(
    `media: cannot create bucket ${config.bucket} — HTTP ${res.status}: ${body.slice(0, 200)}`,
  );
}

/** Whether the store will answer a signed, credentialed request right now (FR-017).
 *
 * A PRESIGNED URL NEEDS NO CONTACT WITH THE STORE, WHICH IS THE WHOLE PROBLEM. Signing
 * is five HMAC rounds over strings; the api never opens a socket, so it never learns
 * that the store is down and a slot issued into an outage looks identical to a good
 * one. The client finds out, at upload time, holding a URL nobody can use.
 *
 * `docs/05-sad.md:1062` asks for the opposite — *"Object storage lost … Upload slots
 * return a specific error"* — so this round trip exists only to produce a refusal. That
 * is a real cost on the happy path and it is written down rather than hidden: one signed
 * HEAD on the bucket per slot request.
 *
 * A HEAD ON THE BUCKET AND NOT A GET ON AN OBJECT. The bucket always exists (boot
 * created it) and a HEAD returns no body, so the question is exactly "is the store
 * answering credentialed requests" and nothing else. An object GET would conflate a
 * missing key with a missing store.
 *
 * AND A TIMEOUT, BECAUSE "CANNOT BE REACHED" INCLUDES "DOES NOT ANSWER". A store that
 * accepts the connection and then hangs would otherwise hold the request open until the
 * client gave up, turning a refusal this function exists to produce into a timeout the
 * client has to interpret. Two seconds: long enough for a loaded store on a shared
 * machine, short enough that a slot request never becomes the slowest thing in the api.
 */
export async function storeReachable(config: StoreConfig): Promise<boolean> {
  const url = presign({ method: "HEAD", ...config, expiresIn: 60 });
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    // CONNECTION REFUSED, DNS FAILURE, TIMEOUT — all the same answer to the caller.
    // Distinguishing them here would be a second vocabulary for one refusal, and the
    // client's action is identical in every case.
    return false;
  }
}
