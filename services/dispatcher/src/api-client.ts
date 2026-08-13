import {
  internalDeliveryMaterialSchema,
  internalDeliveryOutcomeResponseSchema,
  internalExpandResponseSchema,
  type InternalDeliveryMaterial,
  type InternalDeliveryOutcomeRequest,
  type InternalDeliveryOutcomeResponse,
  type InternalExpandRequest,
  type InternalExpandResponse,
} from "@relay/protocol";

// The dispatcher's only road to state (chapter 3.5, constitution IV).
//
// "Only the API service writes to PostgreSQL… Other services obtain writes and
// backfill reads via the API service's internal endpoints." This file is the
// whole of that road — there is no database client in this service, and the lint
// rule that forbids importing `pg` or `drizzle-orm` outside the api's `db/`
// makes that a property of the build rather than of anyone's discipline.
//
// Shaped exactly like the gateway's (chapter 2.5), for the reason 2.5 gave:
// request and response types come from `@relay/protocol`, so the day a field is
// renamed both sides fail loudly instead of one reading `undefined` three layers
// away. And responses are PARSED, not assumed — an internal caller has no more
// right to trust a payload's shape than an external one does.

export class ApiError extends Error {
  readonly status: number;

  constructor(what: string, status: number) {
    super(`${what} failed: ${status}`);
    this.name = "ApiError";
    // Declared and assigned rather than a parameter property:
    // `erasableSyntaxOnly` is on everywhere except the api (ADR-15).
    this.status = status;
  }
}

export interface ApiClient {
  /** One event becomes one delivery per matching endpoint. Claimed on the api's
   * side, so a redelivered event expands exactly once. */
  expand(event: InternalExpandRequest): Promise<InternalExpandResponse>;
  /** Everything needed to sign and post — including the decrypted signing
   * secrets. Null means the delivery is no longer deliverable: its endpoint was
   * paused or removed after the delivery was scheduled. */
  material(deliveryId: string): Promise<InternalDeliveryMaterial | null>;
  /** What happened. Idempotent on `(delivery_id, attempt)` at the api. */
  reportOutcome(
    outcome: InternalDeliveryOutcomeRequest,
  ): Promise<InternalDeliveryOutcomeResponse>;
}

export function createApiClient(
  baseUrl: string,
  credential: string,
): ApiClient {
  // The platform credential, not an API key. An `application` principal is
  // scoped to ONE environment by construction, and the dispatcher serves every
  // environment — so a route accepting one here would either be useless or would
  // have to ignore the scope, and ignoring a tenant scope is the shape a
  // cross-tenant hole takes (research R6).
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${credential}`,
  };

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/internal/dispatch/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  return {
    async expand(event) {
      const res = await post("expand", event);
      if (!res.ok) throw new ApiError("expand", res.status);
      return internalExpandResponseSchema.parse(await res.json());
    },

    async material(deliveryId) {
      const res = await post("material", { delivery_id: deliveryId });
      // 404 is not an error here: an endpoint paused or deleted after the
      // delivery was scheduled makes it undeliverable, and the spec's edge case
      // says such a delivery must not be sent. A throw would turn a normal
      // outcome into a retry loop.
      if (res.status === 404) return null;
      if (!res.ok) throw new ApiError("material", res.status);
      return internalDeliveryMaterialSchema.parse(await res.json());
    },

    async reportOutcome(outcome) {
      const res = await post("outcome", outcome);
      if (!res.ok) throw new ApiError("outcome", res.status);
      return internalDeliveryOutcomeResponseSchema.parse(await res.json());
    },
  };
}
