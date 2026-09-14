// The write side. Node's own `fetch` against the HTTP interface -- no client package, which
// is what keeps `grep -c clickhouse pnpm-lock.yaml` at 0 by design rather than by luck.
import type { AttemptRow } from "./shape.js";

const DB = "relay_analytics";
const TABLE = "webhook_attempts";

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
  count(): Promise<number>;
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
    // One statement, one block. No deduplication token: the table is a ReplacingMergeTree
    // keyed on (environment_id, ts, delivery_id, attempt), so a re-inserted record collapses
    // regardless of how it was batched -- which a token cannot do, because JetStream batch
    // boundaries are not stable across a redelivery.
    async insert(rows: AttemptRow[]): Promise<void> {
      if (rows.length === 0) return;
      await post(
        `INSERT INTO ${DB}.${TABLE} FORMAT JSONEachRow`,
        rows.map((r) => JSON.stringify(r)).join("\n"),
      );
    },
    // Reads take FINAL. The duplicate is physically present until a merge collapses it, so a
    // bare count over-counts every redelivery -- by a plausible number.
    async count(): Promise<number> {
      return Number(await post(`SELECT count() FROM ${DB}.${TABLE} FINAL`, ""));
    },
  };
}
