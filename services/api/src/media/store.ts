import { presign } from "./presign";

// WHERE THE OBJECT STORE IS, AND THE ONE CALL THE API MAKES TO IT DIRECTLY.
//
// Every other call is made by the CLIENT against a URL this service signs (ADR-13).
// The exception is creating the bucket, which has to happen once before any slot can
// be issued and which nothing else in the stack does.

export interface StoreConfig {
  /** WHERE THE CLIENT REACHES THE STORE. This is the origin signed into an upload URL,
   * and the client is outside this process by construction (ADR-13). */
  endpoint: string;
  /** WHERE THIS SERVICE REACHES THE STORE, and it is a second field because the host is
   * inside the signature.
   *
   * `X-Amz-SignedHeaders: host` — a URL signed for one origin is refused at another, so
   * the two consumers of this config cannot share one address once they disagree. They
   * agreed until the api ran anywhere but the host: `compose.yaml` publishes MinIO on
   * `localhost:9100` for the client and reaches it as `minio:9000` from inside the
   * network, and the composed api answered **503 to every slot request** because the
   * default put its own probe at `localhost:9100`, which inside that container is that
   * container. Measured: `localhost:9100 -> ECONNREFUSED`, `minio:9000 -> 200`, from a
   * shell in the api while the same store answered 200 to the host.
   *
   * DEFAULTS TO `endpoint`, so every lane that runs the api as a host process is
   * unchanged and nothing has to know this field exists until the two addresses differ. */
  internalEndpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export function storeConfig(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const endpoint = env.RELAY_MINIO_ENDPOINT ?? "http://localhost:9100";
  return {
    endpoint,
    internalEndpoint: env.RELAY_MINIO_INTERNAL_ENDPOINT ?? endpoint,
    accessKey: env.RELAY_MINIO_ACCESS_KEY ?? "relay",
    secretKey: env.RELAY_MINIO_SECRET_KEY ?? "relay-secret",
    bucket: env.RELAY_MINIO_BUCKET ?? "relay-media",
  };
}

/** Create the bucket, or confirm it is already ours.
 *
 * WITH THE SIGNER THIS MODULE ALREADY HAS. The alternatives were an entrypoint script
 * and a migration-like runner; both add a moving part for one idempotent call. What
 * makes running it unconditionally safe is that the store has a NAME for the second
 * attempt — `BucketAlreadyOwnedByYou`, 409 — rather than a generic failure, so "already
 * there" and "went wrong" are distinguishable without a flag.
 *
 * AND ITS CALLER IS `storeReady` BELOW, NOT A BOOT HOOK. An earlier version of this
 * comment said *"on boot, every boot"* and **nothing called it on boot** — only test
 * `beforeAll` hooks did. Every local run passed because the bucket already existed from
 * the first one; CI's fresh volume is what said so, with two suites that never touch
 * this file answering 503 to a slot request. A comment describing behaviour no code
 * performs is the defect this chapter keeps finding in other people's files. */
export async function ensureBucket(config: StoreConfig): Promise<"created" | "exists"> {
  // `internalEndpoint`, NOT `endpoint`. This is the one call the api makes itself, so it
  // signs for the address the api can reach rather than the one the client is given.
  const url = presign({
    method: "PUT",
    ...config,
    endpoint: config.internalEndpoint,
    expiresIn: 60,
  });
  const res = await fetch(url, { method: "PUT" });
  if (res.ok) return "created";

  const body = await res.text();
  if (body.includes("BucketAlreadyOwnedByYou")) return "exists";

  // ANYTHING ELSE IS FATAL AND SAYS SO, AND ITS ONE CALLER TURNS IT INTO A REFUSAL.
  // `storeReady` below catches this and answers `false`, which becomes a 503 the client
  // can read — a store the api cannot write to is a store every slot request will fail
  // against, and the message carries the status and the body so the operator sees which.
  throw new Error(
    `media: cannot create bucket ${config.bucket} — HTTP ${res.status}: ${body.slice(0, 200)}`,
  );
}

/** Whether the store can accept an upload right now (FR-017).
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
 * A HEAD ON THE BUCKET AND NOT A GET ON AN OBJECT. The bucket is the thing an upload
 * needs to exist, and a HEAD returns no body — so the question is exactly "will this
 * store take a PUT under this prefix" and nothing else. An object GET would conflate a
 * missing key with a missing store.
 *
 * AND A 404 IS NOT A REFUSAL, IT IS THE FIRST REQUEST. A reachable store with no bucket
 * answers 404, which is what a fresh volume looks like — so that arm creates the bucket
 * and carries on. This is the only place that creates it: putting it in a boot hook
 * leaves a store that was down at boot permanently bucketless, and putting it on every
 * request would need `CreateBucket` on a credential that may only be granted
 * `PutObject`. Here it is asked for exactly once per store, on the first slot request
 * that finds it missing.
 *
 * AND A TIMEOUT, BECAUSE "CANNOT BE REACHED" INCLUDES "DOES NOT ANSWER". A store that
 * accepts the connection and then hangs would otherwise hold the request open until the
 * client gave up, turning a refusal this function exists to produce into a timeout the
 * client has to interpret. Two seconds: long enough for a loaded store on a shared
 * machine, short enough that a slot request never becomes the slowest thing in the api.
 */
export async function storeReady(config: StoreConfig): Promise<boolean> {
  // `internalEndpoint` for the same reason `ensureBucket` uses it: this probe is the api
  // asking the store a question, not a URL anybody else will hold.
  const url = presign({
    method: "HEAD",
    ...config,
    endpoint: config.internalEndpoint,
    expiresIn: 60,
  });
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2_000) });
    if (res.ok) return true;
    if (res.status !== 404) return false;
    await ensureBucket(config);
    return true;
  } catch {
    // CONNECTION REFUSED, DNS FAILURE, TIMEOUT, AND A BUCKET THAT WOULD NOT CREATE —
    // all the same answer to the caller. Distinguishing them here would be a second
    // vocabulary for one refusal, and the client's action is identical in every case.
    return false;
  }
}
