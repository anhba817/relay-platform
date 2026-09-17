// The api's own ClickHouse caller, and it is the second one in this repository.
//
// WHY NOT REUSE THE INGESTER'S. That interface — `insert`, `insertRequests`,
// `insertConnections`, three counts, and a `query` chapter 4.6 added — lives in
// `services/ingester/src/clickhouse.ts` and is exported from no package. The api depends on
// `@relay/protocol` and `@relay/service-kit` only, and a service depending on another service
// is not a shape this repository has.
//
// AND THE ALTERNATIVE WAS REFUSED ON COUNTS RATHER THAN TASTE. Moving that interface into
// `@relay/service-kit` would work: it has **zero dependencies and five dependents**, so it
// would gain a network client and push it onto five services, and the file it would come from
// carries four fences across four chapters. A cross-service refactor is not what a chapter
// about reconciliation should spend.
//
// SO 4.6's "ONE CLIENT PER SERVICE" SURVIVES AS THE PER-SERVICE CLAIM IT ALWAYS WAS. That
// chapter gave the ingester's interface a `query()` so a read placed beside it would not open
// a second client IN THE INGESTER. This makes the api the second service to hold a caller,
// which is the concrete form of the constitution III question this chapter has to answer: the
// service that IS the operational path now reads the analytical store directly.
//
// READ-ONLY, DELIBERATELY. The reconciler compares and writes nothing, and an interface with
// no insert cannot be talked into one.

/** A read against the analytical store. Rows as TSV, split by tab. */
export interface AnalyticalStore {
  query(sql: string): Promise<string[][]>;
}

/** A refusal from the store, CARRYING THE HTTP STATUS (chapter 4.8, FR-025).
 *
 * The client used to throw `new Error(text.trim().split("\n")[0])` and drop everything
 * else, so a caller that needed to tell a timeout from a bad query had to string-match
 * `Code: 159` — parsing a server error message to recover a fact the response already
 * carried. Asked of the server directly:
 *
 *   SETTINGS max_execution_time = 1 on a long scan   →  408, Code: 159 (TIMEOUT_EXCEEDED)
 *   SELECT nope FROM …                               →  404, Code:  47 (UNKNOWN_IDENTIFIER)
 *
 * So the status already tells the two cases apart and only the client was losing it.
 *
 * THE MESSAGE IS FOR THE LOG AND NEVER FOR THE RESPONSE. `Code: 159. DB::Exception:
 * Timeout exceeded: elapsed 1000.343075 ms, maximum: 1000 ms` in a customer's support
 * ticket is infrastructure detail, which is the argument `codes.ts` already makes about
 * credentials (NFR-SEC-06). */
export class AnalyticalStoreError extends Error {
  constructor(
    message: string,
    /** ClickHouse's own HTTP status, or 0 when the request never got an answer —
     *  an abort, a refused connection, a DNS failure. */
    readonly status: number,
  ) {
    super(message);
    this.name = "AnalyticalStoreError";
  }
}

export function createAnalyticalStore({
  host = process.env["RELAY_CLICKHOUSE_HOST"] ?? "localhost",
  port = process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123",
  user = process.env["RELAY_CLICKHOUSE_USER"] ?? "relay",
  password = process.env["RELAY_CLICKHOUSE_PASSWORD"] ?? "relay",
  timeoutMs,
}: {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  /** DEFAULTS TO NONE, WHICH KEEPS CHAPTER 4.7's BEHAVIOUR EXACTLY (FR-025).
   *
   * Neither ClickHouse client in this repository had a timeout: both call `fetch` with
   * no `signal`, so a hung store holds the caller until the operating system gives up.
   * On the nightly reconciler that is tolerable — nobody is waiting — and on a customer
   * request it is the coupling constitution III's second clause forbids: *"failure or
   * backlog of the analytical pipeline MUST NOT affect … API availability."*
   *
   * Opt-in rather than defaulted so the reconciler keeps the behaviour it was measured
   * with, and only the route that serves a person passes one.
   *
   * AND IT IS HALF A DEADLINE ON ITS OWN. Aborting a `fetch` stops the CLIENT waiting;
   * ClickHouse keeps executing, so a tenant retrying a slow page accumulates server-side
   * work — the amplification the deadline exists to prevent. The other half rides in the
   * SQL as `SETTINGS max_execution_time` and belongs to the caller, because only the
   * caller knows what it is asking for. */
  timeoutMs?: number;
} = {}): AnalyticalStore {
  const auth = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  return {
    query: async (sql: string): Promise<string[][]> => {
      // ONE STATEMENT PER REQUEST. The HTTP interface refuses a multi-statement body with
      // `Code: 62`, which chapter 4.2 established is the interface's rule rather than a
      // tidiness convention.
      let res: Response;
      try {
        res = await fetch(`http://${host}:${port}/`, {
          method: "POST",
          headers: { Authorization: auth },
          body: sql,
          // `AbortSignal.timeout` and not a hand-rolled race, which is the pattern
          // `services/dispatcher/src/deliver.ts` already carries one outbound call over.
          ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });
      } catch (cause) {
        // STATUS 0 BECAUSE THERE IS NO RESPONSE TO TAKE ONE FROM. An abort, a refused
        // connection and a DNS failure are all this arm, and a caller that maps on the
        // status gets one value meaning "the store did not answer" rather than three
        // strings to match.
        throw new AnalyticalStoreError(
          cause instanceof Error ? cause.message : "clickhouse did not answer",
          0,
        );
      }
      const text = await res.text();
      if (!res.ok)
        throw new AnalyticalStoreError(
          text.trim().split("\n")[0] ?? "clickhouse refused",
          res.status,
        );
      const trimmed = text.trim();
      return trimmed === "" ? [] : trimmed.split("\n").map((line) => line.split("\t"));
    },
  };
}
