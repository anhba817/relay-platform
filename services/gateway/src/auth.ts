import type { ApiClient, Identity } from "./api-client.js";

// The door (chapter 2.5, rebuilt by 3.2). Tokens are still checked BEFORE the
// handshake completes — an unauthenticated socket never reaches session code —
// but the gateway no longer does the checking.
//
// WHAT CHANGED, and why it is a narrowing rather than a complication: 2.5's
// gateway verified tokens itself, with HS256 over a shared development secret.
// Real tokens are signed with the ENVIRONMENT'S OWN secret, and that secret
// lives in Postgres — which ADR-05 says this service may never touch. The two
// ways out were to ship every environment's signing secret to the gateway, or to
// ask the service that owns them. Shipping the secret means a tenant-scoped
// secret inside a process that deliberately holds no tenant state, plus a
// rotation story; asking costs one HTTP call the connect path was ALREADY making
// for memberships (research R1).
//
// So the round-trip count is unchanged: the memberships lookup became a session
// lookup that answers identity and memberships together. The gateway holds no
// signing secret after this chapter.

export type { Identity } from "./api-client.js";

/** Three outcomes, not two. A refused token and an unreachable api both fail to
 * open a socket, but they are not the same event and must not close the same
 * way: 4001 tells a client its credential is wrong (retrying will not help),
 * 1011 tells it we are broken (retrying will). 2.5 drew that line for the
 * memberships lookup; moving verification here must not erase it. */
export type Authentication =
  | {
      outcome: "ok";
      identity: Identity;
      channelIds: string[];
      /** Chapter 3.8. The environment's two socket allowances, read from
       * Postgres by the api and carried on the same response — the gateway has
       * no database client and R12 spent its whole argument on keeping it that
       * way. */
      limits: { connect: number; send: number };
    }
  | { outcome: "refused" }
  | { outcome: "unavailable"; error: string };

export async function authenticate(
  api: ApiClient,
  token: string | null,
): Promise<Authentication> {
  if (token === null || token.length === 0) return { outcome: "refused" };
  try {
    const session = await api.session(token);
    // The api answered, and the answer was "no". Every refusal — expired,
    // malformed, mis-signed, for another environment, over-long — arrives here
    // as one outcome, because the socket has one close code for all of them.
    if (session === null) return { outcome: "refused" };
    return {
      outcome: "ok",
      identity: {
        environmentId: session.environment_id,
        userExternalId: session.user,
        // Carried, not trusted: the internal hop forwards this instead of
        // asserting an identity the gateway invented.
        token,
      },
      channelIds: session.channel_ids,
      limits: session.limits,
    };
  } catch (error) {
    return { outcome: "unavailable", error: String(error) };
  }
}
