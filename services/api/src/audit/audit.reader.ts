/** FR-006's read: a tenant's moderation history.
 *
 * EVERYTHING HERE EXCEPT THE QUERY, which is `db/audit-reads.ts` because
 * `eslint.config.mjs` puts the query engine in the repository layer. The split is the
 * request log's: that reader composes a page out of a store client it does not implement,
 * and this one composes a page out of a read it does not write.
 *
 * AND THERE IS NO DEADLINE HERE, WHICH IS A DECISION. ADR-26 put a customer-facing log on
 * the request path and answered it with a limit on both sides, after measuring that
 * aborting a `fetch` stops the client waiting while ClickHouse keeps executing — so a
 * tenant retrying a slow page accumulates server-side work. Neither half of that applies:
 * this read is a keyset page of at most 200 rows on `(environment_id, occurred_at DESC,
 * id DESC)`, a bounded index range rather than a scan, and Postgres is the operational
 * store, so constitution III's *"failure or backlog of the analytical pipeline MUST NOT
 * affect API availability"* is about a dependency this route does not have. If the planner
 * ever does anything other than an index range here, this paragraph is wrong and
 * `statement_timeout` is the answer — which is why T032a measures the plan rather than
 * asserting this. */
import type { Db } from "../db/client";
import { auditPage, type AuditRow } from "../db/audit-reads";
import { protocolError } from "../protocol-error";
import { decodeAuditCursor, encodeAuditCursor, type AuditPosition } from "./cursor";
import { resolveWindow, type AuditQuery } from "./audit.schema";

/** One entry as a customer reads it.
 *
 * `actor` AND `target` ARE OBJECTS, not four flat columns, because a kind without its
 * identifier beside it is a field a client has to reassemble — and `actor.id` is nullable
 * while `target.id` is not, which the shape says and four flat columns would not.
 *
 * `actor.id` IS NULL FOR A PLATFORM PRINCIPAL, which carries no tenant. No `/internal/`
 * route is in the moderation set, so a null should not reach a tenant's page today — and
 * *should not* is not *cannot*, so the field is nullable here rather than letting the
 * first occurrence be a client's crash. */
export interface AuditEntry {
  id: string;
  occurred_at: string;
  actor: { kind: string; id: string | null };
  action: string;
  target: { kind: string; id: string };
  request_id: string;
}

export interface AuditLogPage {
  entries: AuditEntry[];
  /** Non-null exactly when `has_more`. */
  next_cursor: string | null;
  /** Go back the way you came. Non-null exactly when the caller arrived holding a cursor,
   *  because a reader cannot know whether rows exist before the first one without asking
   *  a second question. */
  prev_cursor: string | null;
  /** EIR-API-06, which this platform was non-conforming with until chapter 4.8 and which
   *  a second list endpoint shipping without it would have joined. */
  has_more: boolean;
  window: { from: string; to: string };
  /** AND NO `retention_edge`, which is the one field of the precedent's envelope this
   *  route drops. The request log publishes it because its table has a 30-day TTL.
   *  Nothing prunes this one, so the field would publish a boundary that does not exist,
   *  and an audit log announcing a retention edge it does not enforce is a worse sentence
   *  than no field at all. */
}

function entryFrom(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    occurred_at: row.occurredAt.toISOString(),
    actor: { kind: row.actorKind, id: row.actorId },
    action: row.action,
    target: { kind: row.targetKind, id: row.targetId },
    request_id: row.requestId,
  };
}

function positionOf(row: AuditRow): AuditPosition {
  return { occurredAt: row.occurredAt, id: row.id };
}

export interface AuditReader {
  page(environmentId: string, query: AuditQuery, now?: Date): Promise<AuditLogPage>;
}

export function createAuditReader(db: Db): AuditReader {
  return {
    async page(environmentId, query, now = new Date()): Promise<AuditLogPage> {
      const win = resolveWindow(query, now);

      const after = query.cursor === undefined ? null : decodeAuditCursor(query.cursor);
      if (after === null && query.cursor !== undefined) {
        // NEVER A SILENT FALL BACK TO THE TOP OF THE WINDOW, which would serve a page the
        // caller did not ask for and look like working software (chapter 2.4's rule).
        throw protocolError("invalid_request", "malformed cursor", 400, "cursor");
      }

      const rows = await auditPage(db, environmentId, {
        from: win.from,
        to: win.to,
        action: query.action,
        // ONE ROW MORE THAN ASKED FOR, dropped below — the convention `repository.ts`
        // already states. Without it a page that exactly exhausts the window advertises a
        // next page that turns out empty.
        limit: query.limit + 1,
        after: after ?? undefined,
      });

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page.at(-1);
      const first = page[0];

      return {
        entries: page.map(entryFrom),
        next_cursor: hasMore && last ? encodeAuditCursor(positionOf(last)) : null,
        prev_cursor:
          after !== null && first ? encodeAuditCursor(positionOf(first)) : null,
        has_more: hasMore,
        window: { from: win.from.toISOString(), to: win.to.toISOString() },
      };
    },
  };
}
