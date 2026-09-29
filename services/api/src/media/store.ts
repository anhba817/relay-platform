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

/** Remove an object's bytes, keeping the row that records it existed.
 *
 * THE SECOND CALL THE API MAKES TO THE STORE DIRECTLY, and the comment at the top of
 * this file said there was only one until the verification chapter. FR-MED-04 asks for
 * *"deletion of the object, retaining only the audit record"*, which is two actions in
 * two places: this one, and leaving `media_objects` alone.
 *
 * WHY NOT THE WORKER. It holds the bytes in memory already and could sign nothing at
 * all if it deleted them itself — but then a worker that crashed between the delete and
 * the verdict would leave a `pending` row for an object the store no longer has, and
 * the next sweep would read that 404 as *"not uploaded yet"* and wait forever. The api
 * deletes only after the verdict is recorded, so the row and the bytes disagree in one
 * direction only: a `rejected` row whose bytes are still there is repaired by the next
 * call, and there is no state in which a `pending` row has no bytes it could get.
 *
 * S3 DELETE IS IDEMPOTENT AND ANSWERS 204 FOR A KEY THAT WAS NEVER THERE, so a retry
 * needs no branch. What this returns is whether the store said so — a `false` is worth
 * a log line and is not worth failing the verdict over, because the row is already
 * `rejected` and the object is already unattachable. */
export async function deleteObject(
  config: StoreConfig,
  key: string,
): Promise<boolean> {
  const url = presign({
    method: "DELETE",
    ...config,
    endpoint: config.internalEndpoint,
    key,
    expiresIn: 60,
  });
  try {
    const res = await fetch(url, {
      method: "DELETE",
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** DELETE A MEDIA OBJECT'S BYTES AND ITS RENDITIONS' BYTES TOGETHER — FR-003's store half.
 *
 * **CALLED BY NOTHING YET, AND THE REASON IS WORTH READING BEFORE WRITING A CALLER.**
 * Nothing in this platform deletes a `media_objects` ROW. The one live deletion is the
 * rejection path above, which removes bytes and keeps the row on purpose — migration
 * `0018` says *"a rejected object's row is all that survives it"*, because a refusal has
 * to stay auditable after the object is gone. `media_objects_parent_fk` is
 * `ON DELETE CASCADE`, so the database half of FR-003 is already correct for every
 * present and future path; **the store has no cascade and this is the whole of what
 * stands in for one.** The caller arrives with FR-MED-10's reaper — `docs/12` row 22,
 * the erasure chapter.
 *
 * The convention this comment follows is `CLAUDE.md`'s: a claim about when a symbol runs
 * names the thing that runs it, so that the claim rots visibly. *"On boot, every boot"*
 * was false for `ensureBucket` for two chapters because nothing named its caller.
 *
 * **A REJECTED PARENT NEVER HAS RENDITIONS**, so the rejection path needs no change:
 * generation runs after the scan and the declaration check, which is the ordering that
 * makes FR-009 free rather than a cleanup.
 *
 * Every delete is attempted even if an earlier one fails, and the result says whether
 * ALL of them succeeded. A partial failure leaves bytes nobody can reach through this
 * platform — the same condition the rejection path already tolerates and logs. */
export async function deleteObjectWithRenditions(
  config: StoreConfig,
  parentKey: string,
  renditionKeys: readonly string[],
): Promise<boolean> {
  const results = await Promise.all(
    [parentKey, ...renditionKeys].map((key) => deleteObject(config, key)),
  );
  return results.every(Boolean);
}

/** One entry of the object store's own inventory (DR-17, chapter 4.16). */
export interface StoredObject {
  key: string;
  bytes: number;
}

/** WHAT THE STORE SAYS IT HOLDS — the only thing that can contradict the meter.
 *
 * DR-17 asks for the rollup to be *"reconciled weekly against an object-storage inventory
 * listing"*, and nothing in this platform could list a bucket. It turned out to be nearly
 * free: `presign` with no key signs `/{bucket}`, which is a listing, and it already
 * documented that case at 4.10.
 *
 * **IT PAGES, AND THAT IS NOT OPTIONAL.** One response carries 1,000 keys with
 * `IsTruncated: true` against a bucket holding 8,120 objects. **4.13's sweep read one page
 * and an object nobody uploaded to stayed `pending` for ever**; a reconciliation that
 * read one page would report agreement for the 7,000 it never looked at. V1 pages with
 * `marker` — V2's `continuation-token` belongs to `list-type=2`, which is not what was
 * measured.
 *
 * **NO `HEAD` PER OBJECT.** Each entry carries its own `<Size>`, so the inventory costs
 * nine requests rather than 8,120: **430 ms against 11.5 s** at this lane's size.
 *
 * XML BY REGULAR EXPRESSION, DELIBERATELY. The response is a fixed S3 shape with two
 * elements this needs; a parser would be a dependency (ADR-30's ratio) and this platform
 * has hand-written a SigV4 signer rather than take one. */
export async function listObjects(
  config: StoreConfig,
  opts: { maxPages?: number } = {},
): Promise<{ objects: StoredObject[]; pages: number; truncated: boolean }> {
  const maxPages = opts.maxPages ?? 100;
  const objects: StoredObject[] = [];
  let marker: string | undefined;
  let pages = 0;

  for (; pages < maxPages; ) {
    const url = presign({
      method: "GET",
      ...config,
      endpoint: config.internalEndpoint,
      expiresIn: 300,
      ...(marker === undefined ? {} : { params: { marker } }),
    });
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`LIST ${config.bucket}: ${res.status}`);
    const xml = await res.text();
    pages += 1;

    // `[\s\S]` rather than the `s` flag, to match the file's target without a lib bump.
    const entries = xml.matchAll(
      /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
    );
    let last: string | undefined;
    for (const m of entries) {
      objects.push({ key: m[1]!, bytes: Number(m[2]) });
      last = m[1]!;
    }

    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || last === undefined) {
      return { objects, pages, truncated: false };
    }
    marker = last;
  }
  // THE PAGE CAP IS REPORTED, NOT SWALLOWED. A caller that stops early must be able to
  // say its answer is partial — the alternative is a reconciliation reporting agreement
  // about a bucket it did not finish reading.
  return { objects, pages, truncated: true };
}
