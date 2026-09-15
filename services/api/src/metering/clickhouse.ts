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

export function createAnalyticalStore({
  host = process.env["RELAY_CLICKHOUSE_HOST"] ?? "localhost",
  port = process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123",
  user = process.env["RELAY_CLICKHOUSE_USER"] ?? "relay",
  password = process.env["RELAY_CLICKHOUSE_PASSWORD"] ?? "relay",
}: {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
} = {}): AnalyticalStore {
  const auth = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  return {
    query: async (sql: string): Promise<string[][]> => {
      // ONE STATEMENT PER REQUEST. The HTTP interface refuses a multi-statement body with
      // `Code: 62`, which chapter 4.2 established is the interface's rule rather than a
      // tidiness convention.
      const res = await fetch(`http://${host}:${port}/`, {
        method: "POST",
        headers: { Authorization: auth },
        body: sql,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text.trim().split("\n")[0] ?? "clickhouse refused");
      const trimmed = text.trim();
      return trimmed === "" ? [] : trimmed.split("\n").map((line) => line.split("\t"));
    },
  };
}
