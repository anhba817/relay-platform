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

/** A tenant of this test's own, cleaned up whatever happens.
 *
 * ONE ENVIRONMENT PER ASSERTION, AND THE SUITE PAID FOR THE ALTERNATIVE. Its first filter
 * test shared a tenant with the dedup test above and went red on `["/healthz",
 * "/healthz"]` — an assertion scoped wider than the thing it tested, failing for another
 * test's reason eight lines up. A fresh id costs one insert and removes the class. */
async function withProbe(
  rows: readonly Planted[],
  body: (env: string) => Promise<void>,
): Promise<void> {
  const env = randomUUID();
  try {
    await plant(env, rows);
    await body(env);
  } finally {
    await clear(env);
  }
}

const row = (o: Partial<Planted> & { msAgo: number }): Planted => ({
  requestId: randomUUID(),
  endpoint: "/healthz",
  method: "GET",
  status: 200,
  latencyMs: 1,
  principalKind: "application",
  limitedOperation: null,
  ...o,
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

  /** THE SURFACE RETURNS IT ONCE, WHICH IS NOT WHAT `ingest.itest.ts:299` PROVES.
   *
   * That test proves the ENGINE collapses a duplicate key — `count() FINAL` is 1 where
   * the table holds 2. This proves the SURFACE does. A reader that dropped `FINAL` would
   * leave 049's test green and this chapter's page wrong, and the failure would be
   * intermittent: the duplicate this lane actually held was gone by the time this suite
   * was written, removed by a merge nobody asked for.
   *
   * SO THE TEST MAKES ITS OWN, AND STOPS MERGES TO KEEP IT. That is a LANE-WIDE side
   * effect — `ingest.itest.ts:300` stops merges on this exact table and the api lane runs
   * two workers — so the `finally` restores merges AND deletes this probe's own rows.
   * Feature 050's T056 says why in as many words: *"an earlier version of this task named
   * only the stop, which is the one step with a lane-wide side effect."*
   *
   * THE PHYSICAL COUNT IS THE POSITIVE CONTROL. Without it the test passes when the
   * second insert never happened. */
  it("returns a redelivered request once, over a table that physically holds it twice", async () => {
    const probe = randomUUID();
    const duplicate = randomUUID();
    await ch("SYSTEM STOP MERGES relay_analytics.api_requests");
    try {
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
      await plant(probe, [twice]);
      await plant(probe, [twice]);

      const physical = Number(
        await ch(
          `SELECT count() FROM relay_analytics.api_requests
            WHERE environment_id = toUUID('${probe}') AND request_id = toUUID('${duplicate}') FORMAT TSV`,
        ),
      );
      expect(physical, "the second insert did not land; the test below proves nothing").toBe(2);

      const page = await reader.page(probe, query(WIDE()), NOW);
      expect(page.requests).toHaveLength(1);
      expect(page.requests[0]?.request_id).toBe(duplicate);
    } finally {
      await ch("SYSTEM START MERGES relay_analytics.api_requests");
      await clear(probe);
    }
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

describe("what the log can and cannot show", () => {
  /** FR-002, SC-003. THE ASSERTION IS ON THE SECOND TENANT'S ROWS, NOT ON A TOTAL.
   * A count is satisfied by a query that returns the right NUMBER of the wrong rows;
   * chapter 4.4's form names each of the victim's request ids and asserts none of them
   * came back, which is the claim constitution I actually makes. */
  it("returns none of another tenant's rows, by id", async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    const theirIds = [randomUUID(), randomUUID(), randomUUID()];
    try {
      await plant(mine, [row({ msAgo: 5_000 })]);
      await plant(
        theirs,
        theirIds.map((requestId) => row({ msAgo: 5_000, requestId })),
      );
      const page = await reader.page(mine, query(WIDE()), NOW);
      const returned = new Set(page.requests.map((r) => r.request_id));
      for (const id of theirIds) expect(returned.has(id)).toBe(false);
      // AND THE CONTROL: the other tenant's rows really do exist, so the absence above
      // is about the filter rather than about an empty table.
      const other = await reader.page(theirs, query(WIDE()), NOW);
      expect(other.requests.map((r) => r.request_id).sort()).toEqual([...theirIds].sort());
    } finally {
      await clear(mine);
      await clear(theirs);
    }
  });

  /** FR-003, SC-003. 60.5% OF THE LANE'S LOG IS IN THIS STATE — every 404, every 401,
   * `/healthz`, signup, and every call the dispatcher and gateway make on the internal
   * seam, whose `platform` principal carries no `environmentId` by design.
   *
   * Constitution I says every analytical record carries a non-null tenant; chapter 4.4's
   * reading is that the clause governs tenant DATA, and a record with no tenant is not
   * tenant data. That reading is only worth anything because it is testable, and this is
   * the test: the row exists, and it is reachable from no tenant's query. */
  it("never returns a row with no tenant, from any tenant's query", async () => {
    const mine = randomUUID();
    const orphan = randomUUID();
    try {
      await plant(mine, [row({ msAgo: 5_000 })]);
      await plant(null, [row({ msAgo: 5_000, requestId: orphan })]);
      // THE CONTROL, AND IT IS THE HALF THAT MAKES THIS A TEST. The tenantless row is in
      // the table; what follows is that no tenant can reach it, not that it is absent.
      const physical = Number(
        await ch(
          `SELECT count() FROM relay_analytics.api_requests
            WHERE request_id = toUUID('${orphan}') AND environment_id IS NULL FORMAT TSV`,
        ),
      );
      expect(physical).toBe(1);

      for (const tenant of [mine, environmentId, neighbourId]) {
        const page = await reader.page(tenant, query(WIDE()), NOW);
        expect(page.requests.map((r) => r.request_id)).not.toContain(orphan);
      }
    } finally {
      await clear(mine);
      await ch(
        `ALTER TABLE relay_analytics.api_requests DELETE WHERE request_id = toUUID('${orphan}')`,
      );
    }
  });

  /** FR-007, SC-004, SC-020. `has_more` IS WHAT THE `limit + 1` FETCH IS FOR, and the
   * third case is the one it exists for: a page that exactly exhausts the window must
   * not advertise a next page that turns out empty. */
  it("pages without repeating, and says when there is no more", async () => {
    const rows = [0, 1, 2, 3].map((n) => row({ msAgo: 5_000 + n * 1_000 }));
    await withProbe(rows, async (env) => {
      const first = await reader.page(env, query({ ...WIDE(), limit: "2" }), NOW);
      expect(first.requests).toHaveLength(2);
      expect(first.has_more).toBe(true);

      const second = await reader.page(
        env,
        query({ ...WIDE(), limit: "2", cursor: first.next_cursor ?? "" }),
        NOW,
      );
      expect(second.requests).toHaveLength(2);
      expect(second.has_more).toBe(false);
      expect(second.next_cursor).toBeNull();

      const seen = new Set(first.requests.map((r) => r.request_id));
      for (const r of second.requests) expect(seen.has(r.request_id)).toBe(false);
      expect(seen.size + second.requests.length).toBe(4);

      // THE EXACT EXHAUST. Four rows, a limit of four: the window holds nothing more and
      // the page must say so. Without the extra row this reads `has_more: true` and the
      // caller's next request comes back empty.
      const whole = await reader.page(env, query({ ...WIDE(), limit: "4" }), NOW);
      expect(whole.requests).toHaveLength(4);
      expect(whole.has_more).toBe(false);
    });
  });

  /** `direction: newer` — THE HALF THE BRANCH REPORT SAID HAD NEVER RUN.
   *
   * It is in the contract and in the schema, and every test written before this one used
   * the default. Two things change with it and both are in one expression each: the
   * cursor comparison flips from `<` to `>`, and the sort flips from descending to
   * ascending. A page that got one and not the other would return the right rows in the
   * wrong order, or the wrong rows in the right order, and no assertion on the default
   * direction can see either.
   *
   * AND IT IS WHAT `prev_cursor` IS FOR. The envelope carries two cursors because
   * `direction` is two-way — a first draft of this contract shipped one, which leaves a
   * caller reading `newer` with no way back. */
  it("pages backwards, in ascending order, and lands on the rows it came from", async () => {
    const rows = [0, 1, 2, 3].map((n) => row({ msAgo: 5_000 + n * 1_000 }));
    await withProbe(rows, async (env) => {
      const newest = await reader.page(env, query({ ...WIDE(), limit: "2" }), NOW);
      const older = await reader.page(
        env,
        query({ ...WIDE(), limit: "2", cursor: newest.next_cursor ?? "" }),
        NOW,
      );
      // BACK THE WAY IT CAME: `prev_cursor` with the opposite direction.
      const back = await reader.page(
        env,
        query({
          ...WIDE(),
          limit: "2",
          direction: "newer",
          cursor: older.prev_cursor ?? "",
        }),
        NOW,
      );
      expect(back.requests).toHaveLength(2);
      // ASCENDING, which is what `newer` means — the opposite of every other assertion
      // in this file.
      const times = back.requests.map((r) => new Date(r.ts).getTime());
      expect(times[0]).toBeLessThan(times[1] ?? 0);
      // AND THEY ARE THE TWO IT STARTED FROM.
      expect(new Set(back.requests.map((r) => r.request_id))).toEqual(
        new Set(newest.requests.map((r) => r.request_id)),
      );
    });
  });

  /** FR-008, SC-005. BOTH SIDES, BECAUSE THE HALF-OPEN RANGE IS WHERE AN OFF-BY-ONE
   * DUPLICATES A ROW ACROSS TWO PAGES. `from` is inclusive and `to` is exclusive, so a
   * row exactly at `from` is in and a row exactly at `to` is out. */
  it("includes a row exactly at `from` and excludes one exactly at `to`", async () => {
    const atFrom = randomUUID();
    const atTo = randomUUID();
    const inside = randomUUID();
    const FROM = at(60_000);
    const TO = at(30_000);
    await withProbe(
      [
        row({ msAgo: 60_000, requestId: atFrom }),
        row({ msAgo: 45_000, requestId: inside }),
        row({ msAgo: 30_000, requestId: atTo }),
      ],
      async (env) => {
        const page = await reader.page(
          env,
          query({ from: FROM.toISOString(), to: TO.toISOString() }),
          NOW,
        );
        const ids = page.requests.map((r) => r.request_id);
        expect(ids).toContain(atFrom);
        expect(ids).toContain(inside);
        expect(ids).not.toContain(atTo);
        expect(ids).toHaveLength(2);
      },
    );
  });

  /** FR-009, SC-006. THE DECISION, NAMED AS BEHAVIOUR RATHER THAN AS A FILTER.
   *
   * `/internal/*` rows are RETURNED. 1,656 of a tenant's 4,621 attributed rows in this
   * lane are the platform calling itself on that tenant's behalf — `/internal/session`
   * alone is 1,423 — so a customer's own log opens on calls their software did not make.
   * Hiding them would make the log incomplete against FR-ANL-01's *"every request"*, it
   * would need a prefix rule that fails open, and the caller can already exclude them
   * with the `endpoint` filter while the platform cannot un-hide them. */
  it("returns the platform's internal calls made on the tenant's behalf", async () => {
    await withProbe(
      [
        row({ msAgo: 5_000, endpoint: "/internal/session", method: "POST" }),
        row({ msAgo: 4_000, endpoint: "/v1/channels/:channelId/messages", method: "POST" }),
      ],
      async (env) => {
        const page = await reader.page(env, query(WIDE()), NOW);
        expect(page.requests.map((r) => r.endpoint)).toContain("/internal/session");
        // AND THE CALLER CAN GET RID OF THEM, which is the argument the decision rests
        // on: a platform that hides rows offers no way back, and this filter is the way.
        const own = await reader.page(
          env,
          query({ ...WIDE(), endpoint: "/v1/channels/:channelId/messages" }),
          NOW,
        );
        expect(own.requests.map((r) => r.endpoint)).toEqual([
          "/v1/channels/:channelId/messages",
        ]);
      },
    );
  });

  /** FR-035, SC-022. `unmatched` COMES BACK UNDER THAT VALUE AND UNDER NO OTHER. */
  it("filters the request that matched no route, and only that one", async () => {
    const orphanRoute = randomUUID();
    await withProbe(
      [
        row({ msAgo: 5_000, requestId: orphanRoute, endpoint: null, status: 404 }),
        row({ msAgo: 4_000, endpoint: "/healthz" }),
      ],
      async (env) => {
        const unmatched = await reader.page(
          env,
          query({ ...WIDE(), endpoint: "unmatched" }),
          NOW,
        );
        expect(unmatched.requests.map((r) => r.request_id)).toEqual([orphanRoute]);

        const named = await reader.page(
          env,
          query({ ...WIDE(), endpoint: "/healthz" }),
          NOW,
        );
        expect(named.requests.map((r) => r.request_id)).not.toContain(orphanRoute);
      },
    );
  });

  it("filters by endpoint and status together", async () => {
    const both = randomUUID();
    await withProbe(
      [
        row({ msAgo: 5_000, requestId: both, endpoint: "/healthz", status: 429 }),
        row({ msAgo: 4_000, endpoint: "/healthz", status: 200 }),
        row({ msAgo: 3_000, endpoint: "/v1/request-log", status: 429 }),
      ],
      async (env) => {
        const page = await reader.page(
          env,
          query({ ...WIDE(), endpoint: "/healthz", status: "429" }),
          NOW,
        );
        expect(page.requests.map((r) => r.request_id)).toEqual([both]);
      },
    );
  });

  /** FR-010. "NO REQUESTS IN THIS WINDOW" AND "THIS WINDOW IS GONE" ARE THE SAME EMPTY
   * PAGE unless the envelope tells them apart. R8 measured a 120–60 day window returning
   * 0 — which is exactly what a quiet Tuesday returns. */
  it("tells a quiet window from one outside retention", async () => {
    await withProbe([row({ msAgo: 5_000 })], async (env) => {
      const quiet = await reader.page(
        env,
        query({ from: at(90 * 60_000).toISOString(), to: at(80 * 60_000).toISOString() }),
        NOW,
      );
      const gone = await reader.page(
        env,
        query({
          from: new Date(NOW.getTime() - 120 * 86_400_000).toISOString(),
          to: new Date(NOW.getTime() - 60 * 86_400_000).toISOString(),
        }),
        NOW,
      );
      expect(quiet.requests).toEqual([]);
      expect(gone.requests).toEqual([]);

      // THE DIFFERENCE IS READABLE OFF THE ENVELOPE AND NOWHERE ELSE. The quiet window
      // sits inside retention and comes back as asked; the gone one was clamped past its
      // own end, which is what "the data is not here any more" looks like as a value.
      expect(new Date(quiet.window.to).getTime()).toBeGreaterThan(
        new Date(quiet.retention_edge).getTime(),
      );
      expect(new Date(gone.window.to).getTime()).toBeLessThan(
        new Date(gone.retention_edge).getTime(),
      );
      expect(quiet.window.from).not.toBe(quiet.window.to);
      expect(gone.window.from).toBe(gone.window.to);
    });
  });
});
