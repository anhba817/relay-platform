import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAnalyticalStore, type AnalyticalStore } from "../metering/clickhouse";
import { createRequestLogReader, type RequestLogReader } from "./reader";
import { buildRequestLogQuerySchema } from "./request-log.schema";

// FR-ANL-07's read, against the real store (chapter 4.8).
//
// NOT `request-log.itest.ts`, WHICH IS TAKEN. That file is chapter 4.4's end-to-end suite —
// 201 lines, the producer's five reds this feature's `baseline.txt` catalogues, and the
// evidence phase 1 measured. Writing into it would delete the measurement.
//
// EVERY STATEMENT NAMES THIS SUITE'S OWN ENVIRONMENT (FR-024). The analytical store has no
// lane guard at all — 050-2 — so nothing here would stop an unscoped statement. Chapter
// 4.7's suite says the same thing about the same store and it is worth repeating rather
// than cross-referencing: the guard is the habit, not the database.

let store: AnalyticalStore;
let reader: RequestLogReader;
/** This suite's tenant, and a second one that must never appear in its answers. */
let environmentId: string;
let neighbourId: string;

/** The clock every assertion is relative to. Pinned once, before anything is planted, so a
 *  window is a window and not a race against the suite's own duration. */
const NOW = new Date();
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

const ch = async (sql: string): Promise<string> => {
  const res = await fetch(
    `http://${process.env["RELAY_CLICKHOUSE_HOST"] ?? "localhost"}:${process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123"}/`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from("relay:relay").toString("base64"),
      },
      body: sql,
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim().split("\n")[0] ?? "clickhouse refused");
  return text.trim();
};

const sqlInstant = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");
const sqlText = (v: string | null) => (v === null ? "NULL" : `'${v}'`);

interface Planted {
  requestId: string;
  msAgo: number;
  endpoint: string | null;
  method: string;
  status: number;
  latencyMs: number;
  principalKind: string;
  limitedOperation: string | null;
}

async function plant(env: string | null, rows: readonly Planted[]): Promise<void> {
  const values = rows
    .map(
      (r) =>
        `(${env === null ? "NULL" : `toUUID('${env}')`}, toDateTime64('${sqlInstant(at(r.msAgo))}', 3, 'UTC'), toUUID('${r.requestId}'), ${sqlText(r.endpoint)}, '${r.method}', ${r.status}, ${r.latencyMs}, '${r.principalKind}', 'handler', ${sqlText(r.limitedOperation)})`,
    )
    .join(", ");
  await ch(
    `INSERT INTO relay_analytics.api_requests
       (environment_id, ts, request_id, endpoint, method, status, latency_ms, principal_kind, refused_at, limited_operation)
     VALUES ${values}`,
  );
}

/** How many rows this tenant holds. The cleanup ASSERTS on this rather than issuing the
 *  delete and returning — `ALTER TABLE … DELETE` is a queued mutation, and chapter 4.7 found
 *  a row from an earlier run still in the table because the fire-and-forget form leaves no
 *  evidence it ran. Reading the count checks the outcome instead of the queue. */
const rowsFor = async (env: string): Promise<number> =>
  Number(
    await ch(
      `SELECT count() FROM relay_analytics.api_requests
        WHERE environment_id = toUUID('${env}') FORMAT TSV`,
    ),
  );

async function settle(p: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await p()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function clear(env: string): Promise<void> {
  await ch(
    `ALTER TABLE relay_analytics.api_requests DELETE WHERE environment_id = toUUID('${env}')`,
  );
  const done = await settle(async () => (await rowsFor(env)) === 0);
  if (!done) throw new Error(`rows for ${env} survived the delete; the next run would see them`);
}

/** The endpoint set a router would report. Fixed here, because this suite is about the
 *  READ and not about the derivation — `targets.itest.ts` owns that and asserts it against
 *  the running application. */
const schema = buildRequestLogQuerySchema(
  new Set(["/v1/channels/:channelId/messages", "/v1/request-log", "/healthz"]),
);
const query = (q: Record<string, string> = {}) => schema.parse(q);

const WIDE = () => ({
  from: at(60 * 60 * 1000).toISOString(),
  to: at(-60 * 1000).toISOString(),
});

beforeAll(async () => {
  // THE POSITIVE CONTROL, FIRST. Chapter 4.2 spent a chapter on a health check that could
  // not fail for the reason anyone cared about; every number below is a claim about this
  // store, and this line is what makes it one.
  expect(await ch("SELECT 1 FORMAT TSV")).toBe("1");

  store = createAnalyticalStore();
  reader = createRequestLogReader(store);
  environmentId = randomUUID();
  neighbourId = randomUUID();

  await plant(environmentId, [
    {
      requestId: randomUUID(),
      msAgo: 30_000,
      endpoint: "/v1/channels/:channelId/messages",
      method: "POST",
      status: 201,
      latencyMs: 12.5,
      principalKind: "application",
      limitedOperation: null,
    },
    {
      requestId: randomUUID(),
      msAgo: 20_000,
      endpoint: "/healthz",
      method: "GET",
      status: 200,
      latencyMs: 0.556,
      principalKind: "none",
      limitedOperation: null,
    },
    // THE ROW WITH NO ENDPOINT, and it is a 429 because that is what the lane's real ones
    // are: 23 of the 31 rows carrying no endpoint were refused by the limiter before the
    // router ran. `limited_operation` is set on exactly those.
    {
      requestId: randomUUID(),
      msAgo: 10_000,
      endpoint: null,
      method: "POST",
      status: 429,
      latencyMs: 0.201,
      principalKind: "application",
      limitedOperation: "rest",
    },
  ]);
  await plant(neighbourId, [
    {
      requestId: randomUUID(),
      msAgo: 15_000,
      endpoint: "/v1/request-log",
      method: "GET",
      status: 200,
      latencyMs: 3.5,
      principalKind: "application",
      limitedOperation: null,
    },
  ]);
});

afterAll(async () => {
  await clear(environmentId);
  await clear(neighbourId);
});

describe("the request log, read from the store", () => {
  it("returns the tenant's own rows and no neighbour's (constitution I, FR-006)", async () => {
    const page = await reader.page(environmentId, query(WIDE()), NOW);
    expect(page.requests).toHaveLength(3);
    const neighbour = await reader.page(neighbourId, query(WIDE()), NOW);
    expect(neighbour.requests).toHaveLength(1);
    expect(neighbour.requests[0]?.endpoint).toBe("/v1/request-log");
  });

  it("returns the six fields FR-ANL-07 names, newest first (SC-001)", async () => {
    const page = await reader.page(environmentId, query(WIDE()), NOW);
    const [newest, middle, oldest] = page.requests;
    // `direction` DEFAULTS TO `older`, SO NEWEST FIRST — asserted against the contract's
    // stated direction and not against whatever the engine happened to return.
    expect([newest?.status, middle?.status, oldest?.status]).toEqual([429, 200, 201]);
    expect(newest).toMatchObject({ method: "POST", status: 429 });
    expect(typeof newest?.request_id).toBe("string");
    expect(new Date(newest?.ts ?? "").getTime()).toBeGreaterThan(0);
  });

  it("keeps `latency_ms` fractional", async () => {
    const page = await reader.page(environmentId, query(WIDE()), NOW);
    const healthz = page.requests.find((r) => r.endpoint === "/healthz");
    // 0.556 as a `Float32` is not 0.556 as a double; the claim is that it did not become
    // an integer, which is what rounding would have made it (three of four real requests
    // on this api are under 1 ms).
    expect(healthz?.latency_ms).toBeGreaterThan(0);
    expect(healthz?.latency_ms).toBeLessThan(1);
    expect(Number.isInteger(healthz?.latency_ms)).toBe(false);
  });

  /** BOTH ARMS, AGAINST THE REAL STORE (T026b). The store client returns `string[][]` split
   * from a TSV body and ClickHouse writes NULL as the two characters `\N`, so a reader that
   * took the value column alone reports an endpoint of `"\N"` — a string, truthy, and
   * indistinguishable from a route name to everything downstream. */
  describe("absence is not a string", () => {
    it("returns `null` for a request that matched no route, and the route for one that did", async () => {
      const page = await reader.page(environmentId, query(WIDE()), NOW);
      const unmatched = page.requests.filter((r) => r.endpoint === null);
      expect(unmatched).toHaveLength(1);
      expect(unmatched[0]?.status).toBe(429);
      expect(page.requests.map((r) => r.endpoint)).not.toContain("\\N");
      expect(page.requests.filter((r) => typeof r.endpoint === "string")).toHaveLength(2);
    });

    /** THE SAME CLASS ONE COLUMN OVER, AND IT IS THE COMMON CASE RATHER THAN THE RARE ONE.
     * `limited_operation` is NULL on 11,660 of the lane's 11,683 rows — it is set only when
     * the limiter refused — so a reader that handled `endpoint` alone would report `"\N"`
     * for 99.8% of the table. The first draft of this suite did handle `endpoint` alone. */
    it("returns `null` for `limited_operation` on every row the limiter did not refuse", async () => {
      const page = await reader.page(environmentId, query(WIDE()), NOW);
      const limited = page.requests.filter((r) => r.limited_operation !== null);
      expect(limited).toHaveLength(1);
      expect(limited[0]?.limited_operation).toBe("rest");
      expect(limited[0]?.status).toBe(429);
      expect(page.requests.map((r) => r.limited_operation)).not.toContain("\\N");
    });

    /** THE CONTROL FOR THE TWO ABOVE. They assert that a `\N` never appears; this asserts
     * that the store really does send one, so the tests are about the READER rather than
     * about a store that happens never to produce the character. */
    it("and the store really does answer `\\N` when nobody asks the presence column", async () => {
      const raw = await store.query(
        `SELECT endpoint, limited_operation FROM relay_analytics.api_requests FINAL
          WHERE environment_id = toUUID('${environmentId}') AND status = 429 FORMAT TSV`,
      );
      expect(raw[0]).toEqual(["\\N", "rest"]);
    });
  });

  it("dedups with `FINAL`: a redelivered row is one row", async () => {
    const duplicate = randomUUID();
    const twice: Planted = {
      requestId: duplicate,
      msAgo: 25_000,
      endpoint: "/healthz",
      method: "GET",
      status: 200,
      latencyMs: 0.4,
      principalKind: "none",
      limitedOperation: null,
    };
    await plant(environmentId, [twice]);
    await plant(environmentId, [twice]);
    const page = await reader.page(environmentId, query(WIDE()), NOW);
    expect(page.requests.filter((r) => r.request_id === duplicate)).toHaveLength(1);
    // AND THE STORE REALLY DID HOLD IT TWICE, which is the half that makes the line above
    // a claim about `FINAL` rather than about the insert. Chapter 4.6 learned this the
    // hard way: a dedup test that does not prove the duplicate existed passes against a
    // table a merge has already tidied.
    const both = await ch(
      `SELECT count() FROM relay_analytics.api_requests
        WHERE environment_id = toUUID('${environmentId}') AND request_id = toUUID('${duplicate}') FORMAT TSV`,
    );
    expect(Number(both)).toBe(2);
  });

  it("pages with a composite cursor and never repeats a row (FR-007)", async () => {
    const first = await reader.page(environmentId, query({ ...WIDE(), limit: "2" }), NOW);
    expect(first.requests).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).not.toBeNull();
    expect(first.prev_cursor).toBeNull();

    const second = await reader.page(
      environmentId,
      query({ ...WIDE(), limit: "2", cursor: first.next_cursor ?? "" }),
      NOW,
    );
    const seen = new Set(first.requests.map((r) => r.request_id));
    for (const row of second.requests) expect(seen.has(row.request_id)).toBe(false);
    expect(second.prev_cursor).not.toBeNull();
  });

  /** THE ASSERTION IS "ONLY MATCHING ROWS", NOT "EXACTLY THESE ROWS", and the first draft
   * got that wrong in a way worth keeping. It asserted `["/healthz"]` exactly and went red
   * with `["/healthz", "/healthz"]` — because the dedup test above plants a second
   * `/healthz` row, and the two tests share a tenant. An assertion scoped wider than the
   * thing it tests fails for somebody else's reason, and here "somebody else" was a test
   * eight lines up. What a filter promises is that nothing else comes back; the count of
   * what does is the plant's business. */
  it("filters by endpoint, by `unmatched`, and by status (FR-035)", async () => {
    const byEndpoint = await reader.page(
      environmentId,
      query({ ...WIDE(), endpoint: "/healthz" }),
      NOW,
    );
    expect(byEndpoint.requests.length).toBeGreaterThan(0);
    expect(new Set(byEndpoint.requests.map((r) => r.endpoint))).toEqual(
      new Set(["/healthz"]),
    );

    const unmatched = await reader.page(
      environmentId,
      query({ ...WIDE(), endpoint: "unmatched" }),
      NOW,
    );
    expect(unmatched.requests).toHaveLength(1);
    expect(unmatched.requests[0]?.endpoint).toBeNull();

    const byStatus = await reader.page(environmentId, query({ ...WIDE(), status: "201" }), NOW);
    expect(byStatus.requests.length).toBeGreaterThan(0);
    expect(new Set(byStatus.requests.map((r) => r.status))).toEqual(new Set([201]));
  });

  it("answers a window outside retention with an empty page and the edge, not a refusal (R8)", async () => {
    const page = await reader.page(
      environmentId,
      query({
        from: new Date(NOW.getTime() - 120 * 86_400_000).toISOString(),
        to: new Date(NOW.getTime() - 60 * 86_400_000).toISOString(),
      }),
      NOW,
    );
    expect(page.requests).toEqual([]);
    expect(page.has_more).toBe(false);
    // The caller tells "that is gone" from "nothing happened" by reading these two
    // against each other, which is the whole reason the field is in the envelope.
    expect(new Date(page.window.to).getTime()).toBeLessThan(
      new Date(page.retention_edge).getTime(),
    );
  });
});
