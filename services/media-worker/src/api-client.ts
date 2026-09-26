import {
  internalMediaPendingResponseSchema,
  internalMediaVerdictResponseSchema,
  type InternalMediaPendingItem,
  type InternalMediaVerdictRequest,
  type InternalMediaVerdictResponse,
} from "@relay/protocol";

// THE WORKER'S ONLY ROAD TO STATE (constitution IV, ADR-04).
//
// Shaped after `services/dispatcher/src/api-client.ts`, which is the one existing client
// of this seam — and shaped after it rather than copied from it. 050 recorded a probe
// that copied a shape and dropped its guards, so the two guards that matter are named
// here: responses are PARSED and not assumed, and a refusal is a typed error rather than
// a silently-ignored status.
//
// THERE IS NO DATABASE CLIENT IN THIS SERVICE and the lint rule that forbids importing
// `pg` or `drizzle-orm` outside the api's `db/` makes that a property of the build.

export class ApiError extends Error {
  readonly status: number;

  constructor(what: string, status: number) {
    super(`${what} failed: ${status}`);
    this.name = "ApiError";
    // Declared and assigned rather than a parameter property: `erasableSyntaxOnly`
    // is on everywhere except the api (ADR-15).
    this.status = status;
  }
}

/** The verdict was refused because the object is no longer `pending` and cannot go
 * back. Distinct from `ApiError` because the worker's response is different: it stops
 * and does not retry, where an `ApiError` is a reason to sweep again. */
export class VerdictRefusedError extends Error {
  constructor(mediaId: string) {
    super(`verdict refused for ${mediaId}: the object is already rejected`);
    this.name = "VerdictRefusedError";
  }
}

export interface ApiClient {
  /** The batch. No tenant parameter, because there is nothing to scope: one worker
   * serves every environment (`contracts/media-verification.md` §2). */
  pending(limit: number): Promise<InternalMediaPendingItem[]>;
  /** What the probe found. Idempotent by state at the api — a second identical
   * verdict answers `applied: false`, which is an outcome and not an error.
   *
   * `null` MEANS THE ROW IS GONE, the way the dispatcher's `material` means an
   * endpoint was paused. An earlier version of this returned
   * `{ applied: false, state: "rejected" }` for a 404, which is a fabricated fact
   * about a row nobody has — the exact shape this chapter refuses to write into
   * `media_objects`, one layer out. */
  verdict(
    mediaId: string,
    body: InternalMediaVerdictRequest,
  ): Promise<InternalMediaVerdictResponse | null>;
}

export function createApiClient(
  baseUrl: string,
  credential: string,
): ApiClient {
  // THE WORKER'S OWN CREDENTIAL, NOT THE DISPATCHER'S. Both are platform credentials
  // and until this chapter the worker would have presented `RELAY_INTERNAL_CREDENTIAL`
  // — which `authenticate.middleware.ts` maps to the literal `"dispatcher"`, so every
  // log line and every request-log row for the only service that reads customer bytes
  // would have named a different service.
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${credential}`,
  };

  return {
    async pending(limit) {
      const res = await fetch(
        `${baseUrl}/internal/media/pending?limit=${limit}`,
        { headers },
      );
      if (!res.ok) throw new ApiError("pending", res.status);
      return internalMediaPendingResponseSchema.parse(await res.json()).objects;
    },

    async verdict(mediaId, body) {
      const res = await fetch(`${baseUrl}/internal/media/${mediaId}/verdict`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      // 422 IS NOT A FAILURE OF THIS PROCESS. The object was rejected while this
      // sweep held it — another worker got there, or a previous run of this one did.
      // Retrying would never succeed, so it is raised as its own class and the caller
      // logs it and moves on.
      if (res.status === 422) throw new VerdictRefusedError(mediaId);
      // AND NEITHER IS 404. The row is gone — FR-MED-10's reap, or a tenant deleted.
      // Same reasoning as the dispatcher's `material`: a throw here would turn a
      // normal outcome into a retry loop.
      if (res.status === 404) return null;
      if (!res.ok) throw new ApiError("verdict", res.status);
      return internalMediaVerdictResponseSchema.parse(await res.json());
    },
  };
}
