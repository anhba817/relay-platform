/** The request log's cursor (chapter 4.8, FR-ANL-07, EIR-API-06).
 *
 * OPAQUE, LIKE THE HISTORY CURSOR, AND FOR THE SAME REASON — constitution V offers cursor
 * pagination and not offsets, and a client that never saw inside a token cannot break when
 * the inside changes. `messages/cursor.ts` is the precedent and this is deliberately not
 * an extension of it.
 *
 * AND IT CANNOT KEY THE SAME WAY, WHICH IS THE INTERESTING HALF. The message cursor stands
 * on `(channel_id, sequence)` — a server-assigned strictly increasing number constitution
 * II requires message ordering to use. `api_requests` has no such column. Its key is
 * `(environment_id, ts, request_id)` and `ts` is `DateTime64(3)`, so two requests in the
 * same millisecond are ordered by `request_id` and nothing else. Measured on the lane: 42
 * `(environment_id, ts)` pairs hold more than one row, 89 rows in total. A `ts`-only cursor
 * skips or repeats every one of them, and that share grows with request rate rather than
 * with elapsed time — it gets worse on a busy tenant, which is the tenant that pages.
 *
 * SO THE TOKEN CARRIES THE PAIR, AND THE COMPARISON HAPPENS IN SQL. The `request_id` half
 * travels as its canonical text and is compared as a `UUID` by the store, which is what
 * keeps the comparison consistent with the table's own `ORDER BY`: ClickHouse does not
 * order UUIDs by that text. Comparing them as strings in the statement would produce a
 * page boundary the index disagrees with. */

const PREFIX = "rl:";

/** The canonical text of a UUID, and nothing else.
 *
 * THIS REGULAR EXPRESSION IS PART OF THE INJECTION ARGUMENT, not a tidiness check.
 * `AnalyticalStore.query` takes a SQL string and has no parameter binding (R9), so a
 * cursor is caller-supplied text that reaches a statement. What reaches it is a value this
 * pattern admitted and a number, and neither can carry a quote. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** THE INSTANTS THE COLUMN CAN HOLD, AND `Number.isSafeInteger` IS NOT ONE OF THEM.
 *
 * The first draft bounded the timestamp half with `Number.isSafeInteger` and a 15-digit
 * pattern, and its own refusal block caught it: `rl:999999999999999:<uuid>` is a safe
 * integer, decodes to **the year 33658**, and would have been rendered into a
 * `DateTime64(3)` comparison the store cannot express. A bound on the JavaScript number is
 * not a bound on the instant.
 *
 * Both ends are facts about the column rather than round numbers. The floor is the DDL's
 * own `CONSTRAINT ts_is_real CHECK ts > toDateTime64('2020-01-01 00:00:00', 3, 'UTC')` —
 * no row this cursor could have been minted from is older. The ceiling is
 * `DateTime64`'s representable maximum, `2299-12-31`. */
const TS_FLOOR_MS = Date.UTC(2020, 0, 1);
const TS_CEILING_MS = Date.UTC(2300, 0, 1);

export interface RequestLogPosition {
  /** The row's `ts`, to the millisecond the column stores. */
  ts: Date;
  /** The row's `request_id`, canonical lower-case text. */
  requestId: string;
}

export function encodeRequestLogCursor(at: RequestLogPosition): string {
  return Buffer.from(`${PREFIX}${at.ts.getTime()}:${at.requestId}`, "utf8").toString(
    "base64url",
  );
}

/** Decode a cursor, or null for anything this module did not produce.
 *
 * NULL BECOMES A 400 AT THE ROUTE — never a 500, and never a silent fall back to the top
 * of the window, which would serve a page the caller did not ask for and looks like
 * working software. That is the rule `messages/cursor.ts` wrote in chapter 2.4.
 *
 * `Buffer.from(x, "base64url")` NEVER THROWS: it decodes what it can and drops the rest,
 * so the pattern below is the whole refusal and the `try` around the decode would be
 * decoration. Every field is re-checked after decoding. */
export function decodeRequestLogCursor(token: string): RequestLogPosition | null {
  const raw = Buffer.from(token, "base64url").toString("utf8");
  const match = /^rl:(\d{1,15}):([0-9a-fA-F-]{36})$/.exec(raw);
  if (!match) return null;
  const [, msText = "", idText = ""] = match;
  const ms = Number(msText);
  // AND NO `Number.isSafeInteger` BESIDE THIS. There was one, and the branch report said
  // it could never be false: `\d{1,15}` caps the value at 999,999,999,999,999, which is
  // a safe integer, so the guard was dead the moment the range check went in beside it.
  // Chapter 4.6 reached 100% branches by deleting two arms that could not run; this is
  // the same finding one file over, and the range check subsumes it either way — a value
  // too large to represent exactly is also far past the ceiling.
  if (ms < TS_FLOOR_MS || ms >= TS_CEILING_MS) return null;
  const requestId = idText.toLowerCase();
  if (!UUID.test(requestId)) return null;
  return { ts: new Date(ms), requestId };
}
