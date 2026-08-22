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

/** FOUR outcomes, and chapter 3.11 added the fourth. A refused token, an
 * unreachable api and an exhausted quota all fail to open a socket, and none of
 * them is the same event: 4001 tells a client its credential is wrong (retrying
 * will not help), 1011 tells it we are broken (retrying will), and 4008 tells it
 * the month ran out (retrying will not help until a date the message names).
 * 2.5 drew the first line for the memberships lookup; moving verification here
 * must not erase it, and neither must adding a commercial refusal to it.
 *
 * WHY THE FOURTH IS NOT ONE OF THE OTHER THREE. Before this chapter a 402 fell
 * through `api-client.ts`'s status check into `parse`, which throws — so it
 * arrived here as `unavailable` and closed the socket 1011, telling the client
 * we were broken and that retrying would help. Both wrong. Mapping it to
 * `refused` instead would close 4001, "your credential is bad", which a client
 * acts on by re-authenticating for ever. */
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
  | { outcome: "unavailable"; error: string }
  /** Chapter 3.11. The api answered, and the answer was "this environment has
   * spent its month". Carries the api's own message, because the resume date is
   * in it and a close reason string has nowhere to put one. */
  | { outcome: "over_quota"; message: string };

export async function authenticate(
  api: ApiClient,
  token: string | null,
): Promise<Authentication> {
  if (token === null || token.length === 0) return { outcome: "refused" };
  try {
    const session = await api.session(token);
    // The api answered, and the answer was "no". Every CREDENTIAL refusal —
    // expired, malformed, mis-signed, for another environment, over-long —
    // arrives here as one outcome, because the socket has one close code for all
    // of them.
    if (session === null) return { outcome: "refused" };
    // A quota refusal is not a credential refusal: the token is perfectly good
    // and the month is not.
    if ("quotaExceeded" in session) {
      return { outcome: "over_quota", message: session.quotaExceeded };
    }
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
