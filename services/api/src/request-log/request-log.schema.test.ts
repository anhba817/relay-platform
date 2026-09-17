import { describe, expect, it } from "vitest";

import {
  buildRequestLogQuerySchema,
  clickHouseInstant,
  DEFAULT_WINDOW_MS,
  RETENTION_DAYS,
  resolveWindow,
  UNMATCHED,
} from "./request-log.schema";

/** Three templates, standing in for what `deriveTargets` reports off the running router.
 * A fixed set is what lets every refusal here run with no application, no store and no
 * Docker — which is the phase's whole shape. */
const ENDPOINTS = new Set([
  "/v1/channels/:channelId/messages",
  "/v1/request-log",
  "/internal/session",
]);
const schema = buildRequestLogQuerySchema(ENDPOINTS);

const parse = (q: Record<string, string>) => schema.safeParse(q);
const fieldsOf = (q: Record<string, string>) => {
  const r = parse(q);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};

describe("the request-log query schema", () => {
  it("applies the defaults `historyQuerySchema` already publishes", () => {
    const r = parse({});
    expect(r.success).toBe(true);
    expect(r.success && r.data).toMatchObject({ direction: "older", limit: 50 });
  });

  /** STRICT IS THE HALF THAT IS EASY TO DROP. A plain `z.object` accepts this and serves
   * the default 50, so the caller gets a wrong answer instead of a message naming their
   * typo. The schema this one mirrors is strict; copying its bounds and not its
   * strictness is the specific mistake. */
  it("refuses an unknown query parameter rather than serving the default", () => {
    expect(parse({ limt: "200" }).success).toBe(false);
  });

  describe("limit", () => {
    it.each([
      ["0", false],
      ["1", true],
      ["200", true],
      ["201", false],
      ["-1", false],
      ["1.5", false],
      ["abc", false],
    ])("%s -> %s", (limit, ok) => {
      expect(parse({ limit }).success).toBe(ok);
    });
  });

  describe("the window", () => {
    it("takes an instant at either end", () => {
      expect(
        parse({ from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00+07:00" }).success,
      ).toBe(true);
    });

    it.each([
      ["a bare date, which is not an instant", "2026-09-16"],
      ["a month that does not exist", "2026-13-01T00:00:00Z"],
      ["a relative expression", "now-24h"],
      ["empty", ""],
    ])("refuses %s", (_name, from) => {
      expect(fieldsOf({ from })).toContain("from");
    });

    it("refuses `to` before `from`, and names `to`", () => {
      expect(
        fieldsOf({ from: "2026-09-02T00:00:00Z", to: "2026-09-01T00:00:00Z" }),
      ).toContain("to");
    });

    /** `to` IS EXCLUSIVE, so equal ends describe a window that can hold nothing. Chapter
     * 4.7's half-open day range is the precedent: there an off-by-one reports drift, here
     * it duplicates a row across two pages. */
    it("refuses equal ends, because `to` is exclusive", () => {
      expect(
        fieldsOf({ from: "2026-09-02T00:00:00Z", to: "2026-09-02T00:00:00Z" }),
      ).toContain("to");
    });
  });

  describe("endpoint", () => {
    it("accepts a template the router reports", () => {
      expect(parse({ endpoint: "/v1/request-log" }).success).toBe(true);
    });

    /** R30: the router contains no route for the request that matched none, and that is
     * the query a 404 investigation opens the log for. 32 rows carry it today. */
    it("accepts `unmatched`, which is no route at all", () => {
      expect(parse({ endpoint: UNMATCHED }).success).toBe(true);
    });

    it("refuses a template the router does not report — a 400, not an empty page", () => {
      expect(fieldsOf({ endpoint: "/v1/nope" })).toContain("endpoint");
    });

    it("refuses a value carrying SQL", () => {
      expect(fieldsOf({ endpoint: "/v1/request-log' OR 1=1 --" })).toContain("endpoint");
    });
  });

  describe("status", () => {
    it.each([
      ["99", false],
      ["100", true],
      ["429", true],
      ["599", true],
      ["600", false],
      ["2xx", false],
    ])("%s -> %s", (status, ok) => {
      expect(parse({ status }).success).toBe(ok);
    });
  });
});

describe("resolveWindow", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  const edge = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const win = (q: Record<string, string> = {}) => {
    const parsed = schema.parse(q);
    return resolveWindow(parsed, now);
  };

  it("defaults to the last 24 hours", () => {
    const w = win();
    expect(w.to.toISOString()).toBe(now.toISOString());
    expect(now.getTime() - w.from.getTime()).toBe(DEFAULT_WINDOW_MS);
    expect(w.clamped).toBe(false);
  });

  it("reports the retention edge as the nominal guarantee", () => {
    expect(win().retentionEdge.toISOString()).toBe(edge.toISOString());
  });

  it("leaves a window inside retention alone", () => {
    const w = win({ from: "2026-09-10T00:00:00Z", to: "2026-09-11T00:00:00Z" });
    expect(w.from.toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(w.clamped).toBe(false);
    expect(w.empty).toBe(false);
  });

  /** FR-ANL-08 SAYS NINETY DAYS AND FR-ANL-07 RETAINS THIRTY, so a caller reading the
   * requirements asks for a window the store cannot answer. They get the part it can,
   * flagged, rather than a refusal (R8). */
  it("clamps a 90-day window to the edge and says so", () => {
    const w = win({ from: "2026-06-18T12:00:00Z" });
    expect(w.from.toISOString()).toBe(edge.toISOString());
    expect(w.clamped).toBe(true);
    expect(w.empty).toBe(false);
  });

  /** THE ANSWER IS "THAT IS GONE", NOT "NOTHING HAPPENED", and those are the same empty
   * page unless the window and the edge come back with it. */
  it("reports a window entirely outside retention as empty rather than refusing it", () => {
    const w = win({ from: "2026-05-01T00:00:00Z", to: "2026-06-01T00:00:00Z" });
    expect(w.empty).toBe(true);
    expect(w.clamped).toBe(true);
    expect(w.from.getTime()).toBe(w.to.getTime());
    expect(w.retentionEdge.toISOString()).toBe(edge.toISOString());
  });

  it("puts the boundary exactly on the edge", () => {
    expect(win({ from: edge.toISOString() }).clamped).toBe(false);
    expect(win({ from: new Date(edge.getTime() - 1).toISOString() }).clamped).toBe(true);
  });
});

describe("clickHouseInstant", () => {
  it("renders the millisecond the column stores", () => {
    expect(clickHouseInstant(new Date("2026-09-16T01:02:03.456Z"))).toBe(
      "2026-09-16 01:02:03.456",
    );
  });

  /** THE HOSTILE WINDOW (R9, T020).
   *
   * This is the first caller-supplied value this platform puts into a ClickHouse
   * statement, and *"it is validated upstream"* is the sentence that precedes every
   * injection. So the claim is made in the form that can be checked: for every payload
   * below, the schema refuses it — and the function that renders a window into SQL cannot
   * emit one of those characters whatever it is handed, because it is handed a `Date`.
   *
   * RUN RED FIRST against a version that interpolated the query string directly; every
   * payload landed in the statement intact. The record is in `baseline.txt`. */
  const PAYLOADS = [
    "2026-09-16T00:00:00Z' OR 1=1 --",
    "2026-09-16T00:00:00Z'; DROP TABLE relay_analytics.api_requests; --",
    "' UNION ALL SELECT * FROM system.users --",
    "2026-09-16T00:00:00Z /* */ FORMAT JSON",
    "\\' OR ''='",
  ];

  it.each(PAYLOADS)("the schema refuses %j at the door", (payload) => {
    expect(schema.safeParse({ from: payload }).success).toBe(false);
    expect(schema.safeParse({ to: payload }).success).toBe(false);
  });

  it("renders nothing that could end a literal, whatever instant it is given", () => {
    const instants = [
      new Date(0),
      new Date("2026-09-16T01:02:03.456Z"),
      new Date("2299-12-31T23:59:59.999Z"),
    ];
    for (const at of instants) {
      const sql = clickHouseInstant(at);
      expect(sql).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      // Named one at a time rather than as a character class, because the class is the
      // kind of thing a reader skims past and the list is the actual claim: nothing this
      // function emits can end a literal, start a comment or begin a second statement.
      for (const c of ["'", '"', "\\", ";", "--", "/*"]) {
        expect(sql).not.toContain(c);
      }
    }
  });
});
