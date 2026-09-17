/** FR-ANL-07's read: a tenant's API request log, out of the analytical store.
 *
 * ONE CLIENT PER SERVICE, AND THIS IS THE API's (chapter 4.7's argument, unchanged).
 * `createAnalyticalStore` lives in `metering/clickhouse.ts` and that file's refusal to move
 * the ingester's interface into `@relay/service-kit` still holds: the package has zero
 * dependencies and five dependents, and giving it a network client would push one onto five
 * services for one route's benefit.
 *
 * AND THIS IS CONSTITUTION III's CENTRAL CASE RATHER THAN AN EXCEPTION TO IT — *"dashboard
 * analytics read only from the analytical store"*. Chapter 4.7's conflict was about an
 * auditor reading BOTH stores and stays `gaps.md` 052-6's; nothing here reopens it.
 */
import { protocolError } from "../protocol-error";

import {
  AnalyticalStoreError,
  createAnalyticalStore,
  type AnalyticalStore,
} from "../metering/clickhouse";
import {
  decodeRequestLogCursor,
  encodeRequestLogCursor,
  type RequestLogPosition,
} from "./cursor";
import {
  clickHouseInstant,
  resolveWindow,
  UNMATCHED,
  type RequestLogQuery,
} from "./request-log.schema";

/** THE TWO HALVES OF THE DEADLINE, AND THE SERVER'S IS THE SHORTER ONE (FR-025).
 *
 * `AbortSignal` stops the client waiting and leaves the query running, so a tenant
 * retrying a slow page accumulates server-side work — the amplification a deadline exists
 * to prevent. `max_execution_time` is the half that stops the work.
 *
 * SHORTER ON THE SERVER SO THE SERVER'S REFUSAL WINS THE RACE. Measured: a query over
 * `SETTINGS max_execution_time = 1` came back in **1.002 s with HTTP 408** and `Code: 159
 * … (TIMEOUT_EXCEEDED)`. The other ordering gives an `AbortError` carrying nothing, and a
 * refusal that names no cause is the empty page this requirement exists to avoid. */
const SERVER_DEADLINE_SECONDS = 2;
const CLIENT_DEADLINE_MS = 3_000;

/** One row, as FR-ANL-07 names it plus two the clause does not.
 *
 * FR-ANL-07's six are `request_id`, `ts`, `endpoint`, `method`, `status` and `latency_ms`.
 * The table carries four more, and each was decided rather than swept in:
 *
 *   principal_kind      RETURNED. It says whether the tenant's own software or an end user
 *                       made the call, which is the only handle a customer has on the
 *                       `/internal/*` rows this surface decided to show them.
 *   limited_operation   RETURNED. It is the answer to "why was I 429'd", which is the
 *                       commonest reason to open a request log at all, and the limiter
 *                       STAMPS it — the value is observed, not inferred.
 *   refused_at          NOT RETURNED, and it is the interesting one. Two of its four arms
 *                       are inferred rather than stamped: chapter 4.4 measured that a guard
 *                       refusal and a handler response are byte-identical from the
 *                       producer's vantage point, so `handler` is an inference from
 *                       silence. A customer acting on a value that can be plausibly wrong
 *                       in a column nothing flags is worse off than one who never saw it.
 *   environment_id      NOT RETURNED. The caller is the tenant; telling them their own id
 *                       back is the row's join key, not information.
 *
 * FR-004 — no request or response bodies — IS DISCHARGED BY CONSTRUCTION AND THIS COMMENT
 * IS WHERE IT IS SAID. The producer never recorded a body, so no column holds one and
 * nothing here is filtering anything out. An assertion that cannot fail for its own reason
 * is worth naming as one rather than writing. */
export interface RequestLogRow {
  request_id: string;
  ts: string;
  /** NULL for a request that matched no route, never `""`. Chapter 4.4 paid for the
   *  difference; 31 real rows in the lane carry it — 23 rate-limited before the router
   *  ran, and 8 genuine 404s. */
  endpoint: string | null;
  method: string;
  status: number;
  /** FRACTIONAL, AND ROUNDING IT WOULD BE ONE LINE AND THE WRONG FIX. Three of four real
   *  requests on this api are under 1 ms and would read 0 (chapter 4.4, measured). */
  latency_ms: number;
  principal_kind: string;
  /** NULL on 11,660 of 11,683 rows: it is set only when the limiter refused. */
  limited_operation: string | null;
}

export interface RequestLogPage {
  requests: RequestLogRow[];
  /** Continue in the same `direction`. Non-null exactly when `has_more`. */
  next_cursor: string | null;
  /** Go back the way you came — pass it with the OPPOSITE `direction`. Non-null exactly
   *  when the caller arrived here holding a cursor, because a reader cannot know whether
   *  rows exist before the first one without asking a second question. */
  prev_cursor: string | null;
  has_more: boolean;
  window: { from: string; to: string };
  retention_edge: string;
}

/** The columns, in the order the statement selects them.
 *
 * A NULLABLE COLUMN TAKES TWO SLOTS, AND THAT IS THE WHOLE OF T026a. `AnalyticalStore.query`
 * returns `string[][]` split from a TSV body, and ClickHouse writes NULL as the two
 * characters `\N` — asked of the server: `\N<TAB>GET<TAB>200`. So a naive read reports an
 * endpoint of `"\N"`. The presence column decides instead, which is chapter 4.7's `count()`
 * move against the same class of problem one table over: absence gets a signal of its own
 * rather than a value somebody has to interpret.
 *
 * TWO OF THE TABLE'S THREE NULLABLE COLUMNS ARE SELECTED HERE. `system.columns` names
 * `environment_id`, `endpoint` and `limited_operation`; the first is the filter and never
 * a result. The first draft of this handled `endpoint` alone, which would have reported
 * `"\N"` on the 11,660 rows that are not a 429. */
const SELECT = [
  "toString(request_id)",
  "toString(ts)",
  "endpoint IS NULL",
  "ifNull(endpoint, '')",
  "method",
  "status",
  "latency_ms",
  "principal_kind",
  "limited_operation IS NULL",
  "ifNull(limited_operation, '')",
].join(", ");

/** `2026-09-15 03:19:24.279` → `2026-09-15T03:19:24.279Z`. The column is
 *  `DateTime64(3, 'UTC')`, so the text carries no zone and the zone is not in doubt. */
function isoFromStore(text: string): string {
  return `${text.replace(" ", "T")}Z`;
}

function nullable(isNullFlag: string | undefined, value: string | undefined): string | null {
  return isNullFlag === "1" ? null : (value ?? null);
}

export interface RequestLogReader {
  page(environmentId: string, query: RequestLogQuery, now?: Date): Promise<RequestLogPage>;
}

/** The statement.
 *
 * THE TENANT ID IS IN THE CODE'S OWN HANDS AND NEVER FROM THE REQUEST (FR-024, constitution
 * I). It arrives from the principal the authentication middleware resolved from a
 * credential, and `toUUID(...)` refuses anything that is not one — so the value cannot be
 * both a tenant filter and a payload.
 *
 * EVERY OTHER INTERPOLATED VALUE IS A `Date`, A NUMBER, OR A MEMBER OF A CLOSED SET derived
 * from the running router. Phase 2's measurement is why this is spelled out rather than
 * assumed: put a caller's text in the window and `' OR 1=1 --` takes a query scoped to one
 * tenant from 0 rows to 11,683 across all 152 environments, and a UNION reads
 * `system.users` out through a customer's log page.
 *
 * `FINAL`, AND THE REASON IS IN THE ENGINE. `api_requests` is a `ReplacingMergeTree` keyed
 * `(environment_id, ts, request_id)`: chapter 4.4 chose it because a redelivered batch
 * writes the same request twice, and 4.5 measured `ingestOnce` reporting 16 for a stream
 * holding 8. Measured on this lane: **11,684 rows against 11,683 distinct keys**, one
 * duplicate across two parts. Without `FINAL` that request comes back twice and the repeat
 * disappears whenever a merge happens to run — so FR-007's *"no row appears in two
 * consecutive pages"* would pass or fail on merge timing. Chapter 4.6 wrote the same rule
 * for the other engine (`sum()` with `GROUP BY`): a query whose correctness depends on
 * somebody having run `OPTIMIZE` is right in a demo and wrong in production. */
function statementFor(
  environmentId: string,
  query: RequestLogQuery,
  win: { from: Date; to: Date },
  after: RequestLogPosition | null,
  older: boolean,
): string {
  const where = [
    `environment_id = toUUID('${environmentId}')`,
    // Half-open, and chapter 4.7's day range is the precedent. There an off-by-one
    // reports drift; here it duplicates a row across two pages.
    `ts >= toDateTime64('${clickHouseInstant(win.from)}', 3, 'UTC')`,
    `ts < toDateTime64('${clickHouseInstant(win.to)}', 3, 'UTC')`,
  ];
  if (query.endpoint !== undefined) {
    where.push(
      query.endpoint === UNMATCHED
        ? "endpoint IS NULL"
        : `endpoint = '${query.endpoint}'`,
    );
  }
  if (query.status !== undefined) where.push(`status = ${query.status}`);
  if (after !== null) {
    // THE PAIR, COMPARED AS A TUPLE, AND `request_id` STAYS A `UUID`. ClickHouse does not
    // order UUIDs by their canonical text, so comparing them as strings here would draw a
    // page boundary the table's own `ORDER BY` disagrees with. 42 `(environment_id, ts)`
    // pairs in this lane hold more than one row; a `ts`-only comparison skips or repeats
    // all 89 of them.
    const pair = `(toDateTime64('${clickHouseInstant(after.ts)}', 3, 'UTC'), toUUID('${after.requestId}'))`;
    where.push(`(ts, request_id) ${older ? "<" : ">"} ${pair}`);
  }
  const order = older ? "ts DESC, request_id DESC" : "ts ASC, request_id ASC";
  return [
    `SELECT ${SELECT}`,
    "FROM relay_analytics.api_requests FINAL",
    `WHERE ${where.join(" AND ")}`,
    `ORDER BY ${order}`,
    `LIMIT ${query.limit + 1}`,
    `SETTINGS max_execution_time = ${SERVER_DEADLINE_SECONDS}`,
  ].join(" ");
}

function rowFrom(cells: readonly string[]): RequestLogRow {
  return {
    request_id: cells[0] ?? "",
    ts: isoFromStore(cells[1] ?? ""),
    endpoint: nullable(cells[2], cells[3]),
    method: cells[4] ?? "",
    status: Number(cells[5] ?? 0),
    latency_ms: Number(cells[6] ?? 0),
    principal_kind: cells[7] ?? "",
    limited_operation: nullable(cells[8], cells[9]),
  };
}

function positionOf(row: RequestLogRow): RequestLogPosition {
  return { ts: new Date(row.ts), requestId: row.request_id };
}

/** Turn a store failure into a refusal a client can act on.
 *
 * TWO OUTCOMES, AND THE DIFFERENCE IS WHOSE FAULT IT IS. A timeout (408) or no answer at
 * all (0 — an abort, a refused connection) is the analytical pipeline being unavailable
 * while the api is up, which is exactly the distinction constitution III's second clause
 * turns on, and the client should retry. **Anything else is our statement being wrong** —
 * 404 for an unknown identifier, 400 for a syntax error — and telling a customer to retry
 * a query that will never work is worse than telling them nothing.
 *
 * AND THE STORE'S OWN MESSAGE NEVER TRAVELS. `Code: 159. DB::Exception: Timeout exceeded:
 * elapsed 1000.343075 ms` in a support ticket is infrastructure detail (NFR-SEC-06). */
function refuse(error: unknown): never {
  if (error instanceof AnalyticalStoreError && (error.status === 408 || error.status === 0)) {
    throw protocolError(
      "analytics_unavailable",
      "the analytics service did not answer in time; retry shortly",
      503,
    );
  }
  throw error;
}

export function createRequestLogReader(
  store: AnalyticalStore = createAnalyticalStore({ timeoutMs: CLIENT_DEADLINE_MS }),
): RequestLogReader {
  return {
    async page(environmentId, query, now = new Date()): Promise<RequestLogPage> {
      const win = resolveWindow(query, now);
      const envelope = {
        window: { from: win.from.toISOString(), to: win.to.toISOString() },
        retention_edge: win.retentionEdge.toISOString(),
      };
      const empty = {
        requests: [] as RequestLogRow[],
        next_cursor: null,
        prev_cursor: null,
        has_more: false,
        ...envelope,
      };

      // A WINDOW ENTIRELY OLDER THAN THE RETENTION EDGE COSTS NO QUERY. It cannot hold a
      // row, and the caller learns which by reading `window` against `retention_edge` —
      // "that is gone" rather than "nothing happened" (R8).
      if (win.empty) return empty;

      const after = query.cursor === undefined ? null : decodeRequestLogCursor(query.cursor);
      if (after === null && query.cursor !== undefined) {
        // NEVER A SILENT FALL BACK TO THE TOP OF THE WINDOW, which would serve a page the
        // caller did not ask for and look like working software (chapter 2.4's rule).
        throw protocolError("invalid_request", "malformed cursor", 400, "cursor");
      }

      const older = query.direction === "older";
      const cells = await store
        .query(statementFor(environmentId, query, win, after, older))
        .catch(refuse);
      const rows = cells.map(rowFrom);

      // ONE ROW MORE THAN ASKED FOR, dropped before returning — the convention
      // `repository.ts:3823` already states. Without it a page that exactly exhausts the
      // window advertises a next page that turns out empty.
      const hasMore = rows.length > query.limit;
      const requests = hasMore ? rows.slice(0, query.limit) : rows;
      const last = requests.at(-1);
      const first = requests[0];

      return {
        requests,
        next_cursor: hasMore && last ? encodeRequestLogCursor(positionOf(last)) : null,
        prev_cursor:
          after !== null && first ? encodeRequestLogCursor(positionOf(first)) : null,
        // EIR-API-06 REQUIRES IT AND THIS PLATFORM HAS NEVER HAD IT. `grep has_more` over
        // `services/` and `packages/` returns nothing: `messages.service.ts` has been
        // non-conforming since chapter 2.4. Added here rather than the clause amended
        // away — EIR-API-04's worked example was brought to the code because reshaping an
        // error body would have been breaking under CON-05's URL-versioning rule, and
        // ADDING a field is not, so that escape does not reach this one.
        has_more: hasMore,
        ...envelope,
      };
    },
  };
}
