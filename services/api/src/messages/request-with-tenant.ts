import type { Principal } from "../auth/principal";

/** The request shape the repository factory reads (chapter 2.2, rewritten by
 * the credentials chapter). It used to carry a headers bag, because the tenant arrived as an
 * asserted environment header. It now carries the PRINCIPAL the
 * authentication middleware resolved from a credential — the swap 2.2 promised
 * would be one file, kept to one file.
 *
 * AND THE REQUEST ID, ADDED BY THE AUDIT LOG (FR-MOD-03). `request-context.middleware.ts`
 * has written it onto every request since chapter 1.3 and this type did not mention it,
 * so a provider reading the request through this interface could not see a field that is
 * always there. The audit entry needs it — it is the join to the request log, and the two
 * logs answer different questions about one request.
 *
 * OPTIONAL BECAUSE THE TYPE DESCRIBES WHAT A PROVIDER MAY READ, NOT WHAT THE PLATFORM
 * GUARANTEES. The middleware runs before every route; a test that builds a request object
 * by hand does not. Required here would make the type lie about the second case rather
 * than the first. */
export interface RequestWithTenant {
  principal?: Principal;
  requestId?: string;
}
