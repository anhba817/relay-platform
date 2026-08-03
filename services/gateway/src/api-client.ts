import {
  internalMembershipsResponseSchema,
  internalSendResponseSchema,
  type InternalSendRequest,
  type InternalSendResponse,
} from "@relay/protocol";

// The gateway's only road to state (chapter 2.5, ADR-05): internal HTTP to
// the api service. Not a database client — a client of the service that
// owns the database.
//
// Request and response shapes are NOT written here. They come from
// @relay/protocol's internal contract, the same schemas the api validates
// with, so the two sides cannot drift (ADR-01's payoff, applied to the
// internal hop). And responses are PARSED, not assumed: an internal caller
// has no more right to trust a payload's shape than an external one does —
// the day the api changes a field name, this fails loudly here instead of
// producing an `undefined` seq in an ack three layers away.

export interface Identity {
  environmentId: string;
  userExternalId: string;
}

export interface ApiClient {
  memberships(identity: Identity): Promise<string[]>;
  sendMessage(
    identity: Identity,
    body: InternalSendRequest,
  ): Promise<InternalSendResponse>;
}

export function createApiClient(baseUrl: string): ApiClient {
  const headers = (identity: Identity) => ({
    "content-type": "application/json",
    "x-relay-environment": identity.environmentId,
    "x-relay-user": identity.userExternalId,
  });

  async function parse<T>(
    res: Response,
    schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
    what: string,
  ): Promise<T> {
    if (!res.ok) throw new Error(`${what} failed: ${res.status}`);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success || parsed.data === undefined) {
      throw new Error(`${what} returned a payload the contract does not allow`);
    }
    return parsed.data;
  }

  return {
    async memberships(identity) {
      const res = await fetch(`${baseUrl}/internal/memberships`, {
        headers: headers(identity),
      });
      const body = await parse(
        res,
        internalMembershipsResponseSchema,
        "memberships",
      );
      return body.channel_ids;
    },
    async sendMessage(identity, body) {
      const res = await fetch(`${baseUrl}/internal/messages`, {
        method: "POST",
        headers: headers(identity),
        body: JSON.stringify(body satisfies InternalSendRequest),
      });
      return parse(res, internalSendResponseSchema, "send");
    },
  };
}
