/** The tokens and the port, in their own file so the controller and the module do not
 *  import each other — `request-log.port.ts`'s shape. */
import type { AuditLogPage, AuditReader } from "./audit.reader";
import type { AuditQuery } from "./audit.schema";

export const AUDIT_ACTIONS = "AUDIT_ACTIONS";

/** The reader as the controller sees it: an abstract class so it is both the type and the
 *  injection token, which is how `Repository` is wired. */
export abstract class AuditReaderPort implements AuditReader {
  abstract page(environmentId: string, query: AuditQuery): Promise<AuditLogPage>;
}

/** The filter's vocabulary, which is TWO sets and only one of them is per tenant.
 *
 * `classified()` is what the platform records today — the `moderation` and
 * `moderation-when-application` routes — and it is the same for every caller, so it is
 * computed once.
 *
 * `held(environmentId)` is what this tenant's entries actually carry, and it is a query.
 * An action, once recorded, stays in the vocabulary: a route reclassified out of the set
 * leaves rows behind, and a filter built from the classified set alone would refuse a
 * value a customer can see in their own page.
 *
 * READ ONLY WHEN THE CALLER FILTERS. The query runs on a request that names an `action`
 * and on no other, so the common path stays at one query a page. The request log's module
 * considered deriving its vocabulary from the data and declined on exactly this cost
 * — *"costs a query per page"* — and the difference here is that it does not have to. */
export interface AuditActions {
  classified(): ReadonlySet<string>;
  held(environmentId: string): Promise<ReadonlySet<string>>;
}
