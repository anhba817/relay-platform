import type { RequestWithPrincipal } from "../auth/principal";

// Whose failure was that? (chapter 3.8, FR-039, research R14.)
//
// THE API SEES THE GATEWAY, not the client. A WebSocket handshake is
// authenticated by the gateway forwarding the end user's token to
// `/internal/session`, so the TCP peer is the gateway for every customer at
// once. Counting the peer would put every customer's failed handshakes in one
// bucket, and one attacker would exhaust a threshold that then refused
// everybody.
//
// A FIELD ON THE INTERNAL CONTRACT, NOT A HEADER. A header the caller asserts is
// a header the caller can forge — the exact pattern chapter 3.2 removed when it
// retired the two identity headers the gateway used to send. This one is
// accepted only from a caller already trusted enough to reach the internal
// routes, and it is trusted for exactly one thing: naming who was on the other
// end. The same request is trusted enough not to be throttled and not trusted to
// be the origin.

/** The field the gateway sets on its internal calls. Read from the parsed body
 * rather than a header, so an ordinary customer cannot set it. */
export const CLIENT_ADDRESS_FIELD = "client_address";

export function clientAddress(
  req: RequestWithPrincipal & {
    socket?: { remoteAddress?: string | undefined };
    body?: unknown;
  },
): string {
  const body = req.body;
  if (typeof body === "object" && body !== null) {
    const forwarded = (body as Record<string, unknown>)[CLIENT_ADDRESS_FIELD];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded;
    }
  }
  return req.socket?.remoteAddress ?? "unknown";
}
