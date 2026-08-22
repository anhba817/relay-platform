import { describe, expect, it } from "vitest";

import {
  bucketsFor,
  createMeter,
  MAX_RETAINED_CLOSED,
  minuteOf,
  periodOf,
} from "./meter.js";

const at = (iso: string) => new Date(iso);
const total = (b: Record<string, number>) =>
  Object.values(b).reduce((a, n) => a + n, 0);

describe("bucketsFor — the unit, on a clock the test supplies", () => {
  it("charges a five-second socket one minute", () => {
    expect(bucketsFor(at("2026-08-22T10:00:03Z"), at("2026-08-22T10:00:08Z")))
      .toEqual({ "2026-08-01": 1 });
  });

  it("charges 00:00:59 to 00:01:01 TWO minutes", () => {
    // Two seconds of wall clock. The connection was present in two calendar
    // minutes, and the unit is the minute it was present in.
    expect(bucketsFor(at("2026-01-01T00:00:59Z"), at("2026-01-01T00:01:01Z")))
      .toEqual({ "2026-01-01": 2 });
  });

  it("charges a fresh connection its first minute immediately", () => {
    // Zero would make "just opened" indistinguishable from "never reported".
    const t = at("2026-08-22T10:00:00Z");
    expect(total(bucketsFor(t, t))).toBe(1);
  });

  it("counts every boundary crossed, not the elapsed minutes", () => {
    // Open 10:00:59, now 10:03:01 — 2m02s elapsed, four buckets touched.
    expect(total(bucketsFor(at("2026-08-22T10:00:59Z"), at("2026-08-22T10:03:01Z"))))
      .toBe(4);
  });

  it("charges a thousand five-second sockets a thousand minutes, not eighty-three", () => {
    // The comparison that chose this model. Summing seconds would give
    // 5,000s = 83 minutes and make reconnect churn almost free.
    let minutes = 0;
    for (let i = 0; i < 1000; i++) {
      const open = at(`2026-08-22T10:${String(i % 60).padStart(2, "0")}:03Z`);
      minutes += total(bucketsFor(open, new Date(open.getTime() + 5_000)));
    }
    expect(minutes).toBe(1000);
  });

  it("splits a connection across a month boundary", () => {
    // 23:58:10 to 00:01:40 touches 23:58, 23:59, 00:00 and 00:01 — two buckets
    // in August and two in September, each period credited on its own.
    //
    // The first draft of this test said three and two. Counting boundaries by
    // eye is exactly the arithmetic this function exists to stop anyone doing,
    // and it caught its author first.
    const b = bucketsFor(at("2026-08-31T23:58:10Z"), at("2026-09-01T00:01:40Z"));
    expect(b).toEqual({ "2026-08-01": 2, "2026-09-01": 2 });
    expect(total(b)).toBe(4);
  });

  it("only ever grows, which is what makes a report idempotent", () => {
    const open = at("2026-08-22T10:00:00Z");
    let previous = 0;
    for (const m of [0, 1, 5, 59, 60, 61]) {
      const now = total(bucketsFor(open, new Date(open.getTime() + m * 60_000)));
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });

  it("returns nothing for a clock that has gone backwards", () => {
    // Skew between instances is bounded and real; a negative span is not a
    // credit of -1.
    expect(bucketsFor(at("2026-08-22T10:05:00Z"), at("2026-08-22T10:04:00Z")))
      .toEqual({});
  });
});

describe("the gateway's copy of the calendar", () => {
  it("floors a minute and ignores the seconds", () => {
    expect(minuteOf(at("2026-08-22T14:37:59.999Z"))).toBe("2026-08-22T14:37");
  });

  it("is UTC, not the host's zone", () => {
    expect(periodOf(at("2026-08-31T23:30:00Z"))).toBe("2026-08-01");
    expect(periodOf(at("2026-09-01T00:30:00Z"))).toBe("2026-09-01");
  });
});

// The drift test R18 requires, gateway side. Its twin lives in
// `services/api/src/quotas/period.test.ts` and both hold the SAME instants.
//
// The gateway cannot import the api's `period.ts` — it is another service — so
// the calendar is copied, with the argument `limits.ts` already made for copying
// the window arithmetic. What makes a deliberate duplication different from a
// copy somebody forgot about is that something fails when they diverge. This is
// that something, and feature 030's R50 established the shape.
export const DRIFT_INSTANTS = [
  "2026-01-01T00:00:00Z", "2026-01-01T00:00:59Z", "2026-01-31T23:59:59Z",
  "2026-02-01T00:00:00Z", "2024-02-29T12:00:00Z", "2026-06-15T13:47:22Z",
  "2026-08-31T23:59:30Z", "2026-09-01T00:00:30Z", "2026-12-31T23:59:59Z",
  "2027-01-01T00:00:00Z", "2026-03-01T00:00:00Z", "2026-10-05T09:00:00Z",
];

describe("the two calendars agree (drift test, R18)", () => {
  it("floors every instant to the same period and the same minute", () => {
    // Expected values are written out rather than computed, so that a change to
    // BOTH copies at once still fails here. A drift test that derives its
    // expectation from one of the two things it compares proves nothing.
    const expected: Array<[string, string, string]> = [
      ["2026-01-01T00:00:00Z", "2026-01-01", "2026-01-01T00:00"],
      ["2026-01-01T00:00:59Z", "2026-01-01", "2026-01-01T00:00"],
      ["2026-01-31T23:59:59Z", "2026-01-01", "2026-01-31T23:59"],
      ["2026-02-01T00:00:00Z", "2026-02-01", "2026-02-01T00:00"],
      ["2024-02-29T12:00:00Z", "2024-02-01", "2024-02-29T12:00"],
      ["2026-06-15T13:47:22Z", "2026-06-01", "2026-06-15T13:47"],
      ["2026-08-31T23:59:30Z", "2026-08-01", "2026-08-31T23:59"],
      ["2026-09-01T00:00:30Z", "2026-09-01", "2026-09-01T00:00"],
      ["2026-12-31T23:59:59Z", "2026-12-01", "2026-12-31T23:59"],
      ["2027-01-01T00:00:00Z", "2027-01-01", "2027-01-01T00:00"],
      ["2026-03-01T00:00:00Z", "2026-03-01", "2026-03-01T00:00"],
      ["2026-10-05T09:00:00Z", "2026-10-01", "2026-10-05T09:00"],
    ];
    expect(expected.map(([iso]) => iso)).toEqual(DRIFT_INSTANTS);
    for (const [iso, period, minute] of expected) {
      expect(periodOf(at(iso))).toBe(period);
      expect(minuteOf(at(iso))).toBe(minute);
    }
  });
});

describe("createMeter — what it holds, and what it does not", () => {
  const CONNECTION = {
    id: "0f9c8b7a-6d5e-4c3b-8a19-8f7e6d5c4b3a",
    environmentId: "8b21c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    openedAt: at("2026-08-22T10:00:00Z"),
  };

  const silent = { log: () => undefined };

  function harness(
    reportUsage: (body: unknown) => Promise<unknown>,
    connections: unknown[] = [],
  ) {
    const sent: unknown[] = [];
    const meter = createMeter({
      api: {
        reportUsage: async (body: unknown) => {
          sent.push(body);
          return (await reportUsage(body)) as never;
        },
      } as never,
      registry: { all: () => connections } as never,
      logger: silent as never,
      intervalMs: 1_000_000, // the tests drive `reportOnce` themselves
    });
    return { meter, sent };
  }

  it("holds NOTHING for a connection that is still open", async () => {
    // R3's claim, and the reason there is no outbox here: an open connection's
    // next report carries the same total plus whatever accrued, so a failed
    // report needs no memory at all.
    const { meter } = harness(async () => {
      throw new Error("api down");
    }, [CONNECTION]);

    await meter.reportOnce(at("2026-08-22T10:05:00Z"));
    expect(meter.retained()).toBe(0);
    meter.stop();
  });

  it("holds a CLOSED connection until a report is accepted", async () => {
    // And this is where R3 stops applying: a closed connection has no next
    // report to repair a lost one.
    let up = false;
    const { meter, sent } = harness(async () => {
      if (!up) throw new Error("api down");
      return { credited: 6 };
    });

    meter.closed(CONNECTION as never, at("2026-08-22T10:05:00Z"));
    expect(meter.retained()).toBe(1);

    await meter.reportOnce(at("2026-08-22T10:05:00Z"));
    expect(meter.retained()).toBe(1); // still owed

    up = true;
    await meter.reportOnce(at("2026-08-22T10:06:00Z"));
    expect(meter.retained()).toBe(0);
    expect(sent).toHaveLength(2);
    meter.stop();
  });

  it("reports a closed connection's minutes, not zero", async () => {
    const { meter, sent } = harness(async () => ({ credited: 6 }));
    meter.closed(CONNECTION as never, at("2026-08-22T10:05:00Z"));
    await meter.reportOnce(at("2026-08-22T10:05:00Z"));

    const body = sent[0] as { connections: Array<{ minutes: number }> };
    expect(body.connections[0]!.minutes).toBe(6); // 10:00 through 10:05
    meter.stop();
  });

  it("keeps both halves of a connection that spanned a month boundary", async () => {
    const { meter } = harness(async () => {
      throw new Error("api down");
    });
    meter.closed(
      { ...CONNECTION, openedAt: at("2026-08-31T23:58:00Z") } as never,
      at("2026-09-01T00:01:00Z"),
    );
    // Two periods, two retained entries, neither overwriting the other.
    expect(meter.retained()).toBe(2);
    meter.stop();
  });

  it("counts a discard at the cap rather than dropping it silently", async () => {
    const { meter } = harness(async () => {
      throw new Error("api down");
    });
    for (let i = 0; i < MAX_RETAINED_CLOSED + 5; i++) {
      meter.closed(
        {
          ...CONNECTION,
          id: `0f9c8b7a-6d5e-4c3b-8a19-${String(i).padStart(12, "0")}`,
        } as never,
        at("2026-08-22T10:01:00Z"),
      );
    }
    expect(meter.retained()).toBe(MAX_RETAINED_CLOSED);
    expect(meter.dropped()).toBe(5);
    meter.stop();
  });

  it("sends nothing when there is nothing owed", async () => {
    const { meter, sent } = harness(async () => ({ credited: 0 }));
    await meter.reportOnce(at("2026-08-22T10:00:00Z"));
    expect(sent).toHaveLength(0);
    meter.stop();
  });

  it("drops what it holds when there is no credential to report with", async () => {
    // Null is "not configured", not "accepted". Holding these would grow without
    // bound in a gateway that will never meter.
    const { meter } = harness(async () => null);
    meter.closed(CONNECTION as never, at("2026-08-22T10:05:00Z"));
    await meter.reportOnce(at("2026-08-22T10:05:00Z"));
    expect(meter.retained()).toBe(0);
    meter.stop();
  });
});

// SC-018 / FR-004. The chapter 2.1 lint ban, asserted rather than assumed.
//
// This chapter is the hardest case that ban has faced: the gateway is the only
// process that can see a connection, and the shortest path from here to a
// recorded minute is a `pg` import. It is not taken, and the reason it is not
// taken has to outlive the paragraph that says so — `registry.ts` states the
// property in prose and eslint enforces it, and this makes it something a test
// run reports on.
//
// GREP RATHER THAN BEHAVIOUR, because the claim is about ABSENCE: no input makes
// this service open a connection to Postgres, and the only way to check "no
// input" is to read what the source can do. Chapter 3.8's 4008 test is the
// precedent, including its self-check.
describe("the gateway still owns no database (SC-018, ADR-05)", () => {
  it("imports no database client anywhere in its source", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const here = new URL(".", import.meta.url);
    const files = (await readdir(here)).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".itest.ts"),
    );
    expect(files.length).toBeGreaterThan(5);

    const banned = /^\s*import\s[^;]*\sfrom\s+["'](pg|drizzle-orm|drizzle-orm\/.*)["']/m;
    for (const file of files) {
      const source = await readFile(new URL(file, here), "utf8");
      expect(source, `${file} imports a database client`).not.toMatch(banned);
    }

    // A grep that can only pass is not a check.
    expect('import pg from "pg";').toMatch(banned);
    expect('import { eq } from "drizzle-orm";').toMatch(banned);
  });
});

describe("the timer, and the clock it defaults to", () => {
  it("reports on its own interval without being asked", async () => {
    // Line-for-line the smallest test in this file and the only one that proves
    // the meter is a background thing at all. Everything above drives
    // `reportOnce` directly, which is right for arithmetic and would leave the
    // one line that makes it periodic unexercised.
    const sent: unknown[] = [];
    const meter = createMeter({
      api: {
        reportUsage: async (body: unknown) => {
          sent.push(body);
          return { credited: 1 };
        },
      } as never,
      registry: {
        all: () => [
          {
            id: "0f9c8b7a-6d5e-4c3b-8a19-8f7e6d5c4b3a",
            environmentId: "8b21c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
            openedAt: new Date(Date.now() - 120_000),
          },
        ],
      } as never,
      logger: { log: () => undefined } as never,
      intervalMs: 5,
      // `now` deliberately omitted: this is also the test that the default
      // clock — the one production uses — is wired to the timer.
    });

    await new Promise((r) => setTimeout(r, 40));
    meter.stop();
    expect(sent.length).toBeGreaterThan(0);

    const after = sent.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.length).toBe(after); // stop() means stop
  });
});
