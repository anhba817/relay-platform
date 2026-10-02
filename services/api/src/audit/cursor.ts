/** The audit log's cursor (FR-MOD-03, FR-006, EIR-API-06).
 *
 * OPAQUE, LIKE THE REQUEST LOG'S AND THE HISTORY'S, AND FOR THE SAME REASON — constitution
 * V offers cursor pagination and not offsets, and a client that never saw inside a token
 * cannot break when the inside changes.
 *
 * IT CARRIES A PAIR, BECAUSE `occurred_at` IS NOT UNIQUE. Two moderation actions in one
 * millisecond is what a bulk script does, and a keyset cursor on a non-unique column skips
 * or repeats rows at every page boundary. `request-log/cursor.ts` had already measured the
 * cost on the other store — *"42 `(environment_id, ts)` pairs in this lane hold more than
 * one row; a `ts`-only comparison skips or repeats all 89 of them"* — and the second column
 * of this cursor is why `audit_log_read_idx` has a third.
 *
 * AND THE THIRD CURSOR IN THIS PLATFORM HAS A THIRD PRECISION STORY. The history cursor
 * pages on `seq`, an integer. The request log's is exact because its column is
 * `DateTime64(3, 'UTC')` and its wire format is millisecond — the same instant both ways.
 * This one would NOT have been exact on a default `timestamptz`, which Postgres stores to
 * the microsecond while `toISOString()` emits milliseconds, so a token minted from a
 * transmitted value would sit before every row in its own millisecond. The column is
 * declared `timestamptz(3)` for this reason and the migration says so. */

const PREFIX = "al:";

/** The canonical text of a UUID, and nothing else.
 *
 * UNLIKE THE REQUEST LOG'S, THIS IS NOT AN INJECTION ARGUMENT. That cursor's pattern is
 * load-bearing because `AnalyticalStore.query` takes a SQL string with no parameter
 * binding; this one reaches a parameterised Postgres statement through drizzle, so a quote
 * could not escape anything. It is here because a value that is not a uuid cannot be a row
 * of this table, and the honest answer to a token naming one is a refusal rather than an
 * empty page. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** THE INSTANTS THE COLUMN CAN HOLD, and both ends are facts about it rather than round
 * numbers. The floor is this chapter's own migration — no entry can predate the table —
 * and the ceiling is far enough out to be unreachable while still refusing the year 33658,
 * which is what the request log's first draft let through by bounding the JavaScript
 * number instead of the instant. */
const TS_FLOOR_MS = Date.UTC(2026, 0, 1);
const TS_CEILING_MS = Date.UTC(2300, 0, 1);

export interface AuditPosition {
  /** The row's `occurred_at`, to the millisecond the column stores. */
  occurredAt: Date;
  /** The row's `id`, canonical lower-case text. */
  id: string;
}

export function encodeAuditCursor(at: AuditPosition): string {
  return Buffer.from(
    `${PREFIX}${at.occurredAt.getTime()}:${at.id}`,
    "utf8",
  ).toString("base64url");
}

/** Decode a cursor, or null for anything this module did not produce.
 *
 * NULL BECOMES A 400 AT THE ROUTE — never a 500, and never a silent fall back to the top
 * of the window, which would serve a page the caller did not ask for and look like working
 * software. That is the rule `messages/cursor.ts` wrote in chapter 2.4.
 *
 * `Buffer.from(x, "base64url")` NEVER THROWS: it decodes what it can and drops the rest,
 * so the pattern below is the whole refusal. */
export function decodeAuditCursor(token: string): AuditPosition | null {
  const raw = Buffer.from(token, "base64url").toString("utf8");
  const match = /^al:(\d{1,15}):([0-9a-fA-F-]{36})$/.exec(raw);
  if (!match) return null;
  const [, msText = "", idText = ""] = match;
  const ms = Number(msText);
  if (ms < TS_FLOOR_MS || ms >= TS_CEILING_MS) return null;
  const id = idText.toLowerCase();
  if (!UUID.test(id)) return null;
  return { occurredAt: new Date(ms), id };
}
