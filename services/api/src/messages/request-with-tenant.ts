import type { Principal } from "../auth/principal";

/** The request shape the repository factory reads (chapter 2.2, rewritten by
 * 3.2). It used to carry a headers bag, because the tenant arrived as an
 * asserted environment header. It now carries the PRINCIPAL the
 * authentication middleware resolved from a credential — the swap 2.2 promised
 * would be one file, kept to one file. */
export interface RequestWithTenant {
  principal?: Principal;
}
