// The write side. Node's own `fetch` against the HTTP interface -- no client package, which
// is what keeps `grep -c clickhouse pnpm-lock.yaml` at 0 by design rather than by luck.
import type { AttemptRow, ConnectionRow, RequestRow } from "./shape.js";

const DB = "relay_analytics";
const ATTEMPTS = "webhook_attempts";
const REQUESTS = "api_requests";
const CONNECTIONS = "connection_events";

// TWO SETTINGS, TWO DIFFERENT FAILURES, AND NEITHER IS OPTIONAL.
//
// `input_format_skip_unknown_fields=0` turns a RENAMED field into `Code: 117` instead of a
// silent default. Its server default is 1, which is exactly why the failure it prevents was
// invisible: the insert succeeds and the column takes the epoch.
//
// `date_time_input_format=best_effort` is what parses the ISO-8601 string at all. The
// default `basic` refuses it outright -- `Code: 27. Cannot parse input: expected '"' before
// 'Z"...'` -- which is the loud half of the pair, and the least dangerous.
//
// Neither covers an ABSENT field. The table's `CHECK ts_is_real` does.
const SETTINGS = "input_format_skip_unknown_fields=0&date_time_input_format=best_effort";

export interface ClickHouse {
  insert(rows: AttemptRow[]): Promise<void>;
  /** The second table (chapter 4.4). A separate call rather than a `table` parameter: the two
   *  row shapes are different types and the compiler should say so at the call site. */
  insertRequests(rows: RequestRow[]): Promise<void>;
  /** The third table (chapter 4.5). A third call for the reason there is a second: three row
   *  shapes are three types, and a `table` parameter would let the compiler watch a
   *  `ConnectionRow` go into `api_requests` without a word. */
  insertConnections(rows: ConnectionRow[]): Promise<void>;
  count(): Promise<number>;
  countRequests(): Promise<number>;
  countConnections(): Promise<number>;
  /** A READ, AND THE FIRST ONE THIS INTERFACE HAS HAD (chapter 4.6).
   *
   * Everything above writes or counts. Chapter 4.6 needs to ASK the store a question --
   * FR-ANL-05's four quantities for a tenant and a period -- and a read placed beside this
   * file without going through it would open a second client against the same four
   * environment variables. One client per service is the argument 4.5 made for NATS, and it
   * is a property of the code only if the read comes through here.
   *
   * Rows as TSV lines, split by tab. The caller shapes them: this interface has refused a
   * `table` parameter three times on the grounds that the compiler should watch the types,
   * and a generic row decoder would be the same mistake one level up. */
  query(sql: string): Promise<string[][]>;
}

export function createClickHouse({
  host = process.env["RELAY_CLICKHOUSE_HOST"] ?? "localhost",
  port = process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123",
  user = process.env["RELAY_CLICKHOUSE_USER"] ?? "relay",
  password = process.env["RELAY_CLICKHOUSE_PASSWORD"] ?? "relay",
}: {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
} = {}): ClickHouse {
  const auth = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

  const post = async (query: string, body: string): Promise<string> => {
    const url = `http://${host}:${port}/?${SETTINGS}&query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { method: "POST", headers: { Authorization: auth }, body });
    const text = await res.text();
    if (!res.ok) throw new Error(text.trim().split("\n")[0] ?? "clickhouse insert failed");
    return text.trim();
  };

  return {
    query: async (sql: string): Promise<string[][]> => {
      const text = await post(sql, "");
      return text === "" ? [] : text.split("\n").map((line) => line.split("\t"));
    },
    // One statement, one block. No deduplication token: the table is a ReplacingMergeTree
    // keyed on (environment_id, ts, delivery_id, attempt), so a re-inserted record collapses
    // regardless of how it was batched -- which a token cannot do, because JetStream batch
    // boundaries are not stable across a redelivery.
    async insert(rows: AttemptRow[]): Promise<void> {
      if (rows.length === 0) return;
      await post(
        `INSERT INTO ${DB}.${ATTEMPTS} FORMAT JSONEachRow`,
        rows.map((r) => JSON.stringify(r)).join("\n"),
      );
    },
    // THE EMPTY GUARD IS LOAD-BEARING NOW, WHERE IT WAS TIDINESS BEFORE. One fetch feeds two
    // tables, and the two producers differ by about two orders of magnitude -- so most
    // batches carry requests and no attempts. Without this, every one of them would post an
    // empty INSERT: a round trip and a part that never had to exist.
    async insertRequests(rows: RequestRow[]): Promise<void> {
      if (rows.length === 0) return;
      await post(
        `INSERT INTO ${DB}.${REQUESTS} FORMAT JSONEachRow`,
        rows.map((r) => JSON.stringify(r)).join("\n"),
      );
    },
    // THE EMPTY GUARD MATTERS MORE WITH EVERY PRODUCER. One fetch now feeds three tables and
    // the three rates differ by orders of magnitude -- roughly one connection pair per
    // session against one request record per request -- so most batches carry requests and
    // neither of the others. Without this, each of them posts an empty INSERT per batch.
    async insertConnections(rows: ConnectionRow[]): Promise<void> {
      if (rows.length === 0) return;
      await post(
        `INSERT INTO ${DB}.${CONNECTIONS} FORMAT JSONEachRow`,
        rows.map((r) => JSON.stringify(r)).join("\n"),
      );
    },
    // Reads take FINAL. The duplicate is physically present until a merge collapses it, so a
    // bare count over-counts every redelivery -- by a plausible number.
    async count(): Promise<number> {
      return Number(await post(`SELECT count() FROM ${DB}.${ATTEMPTS} FINAL`, ""));
    },
    async countRequests(): Promise<number> {
      return Number(await post(`SELECT count() FROM ${DB}.${REQUESTS} FINAL`, ""));
    },
    async countConnections(): Promise<number> {
      return Number(await post(`SELECT count() FROM ${DB}.${CONNECTIONS} FINAL`, ""));
    },
  };
}
