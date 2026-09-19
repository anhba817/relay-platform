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
