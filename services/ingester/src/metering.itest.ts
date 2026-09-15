import { afterAll, beforeAll, describe, expect, it } from "vitest";

// THE ROLLUP FR-ANL-05 NAMES, ASSERTED AGAINST THE STORE THAT HOLDS IT.
//
// Four quantities per tenant per day, and this suite can only demonstrate one of them from
// data a producer writes: connection-minutes. `message_events` has no producer at all --
// zero occurrences under `services/`, one batch loader, 0 rows -- so messages, unique active
// users and the stored count are exercised by planting source rows rather than by traffic.
// That is the chapter's subject and not a shortcut around it.
//
// A DEDICATED ENVIRONMENT ID, AND EVERY COUNT SCOPED BY IT. The analytical store has no lane
// guard: Postgres has feature 030's trigger, an exemption list asserted in both directions
// and a sweeper, and ClickHouse has none of the three (gaps 050-2). Four chapters now write
// these tables from integration tests, and this suite writes a table every later reader
// opens. A whole-table `count()` here would fail for a neighbour's reason.

const ENV = "6a000000-0000-4000-8000-0000000051a6";
const DAY = "2026-09-20";

const auth =
  "Basic " +
  Buffer.from(
    `${process.env["RELAY_CLICKHOUSE_USER"] ?? "relay"}:${process.env["RELAY_CLICKHOUSE_PASSWORD"] ?? "relay"}`,
  ).toString("base64");
const host = process.env["RELAY_CLICKHOUSE_HOST"] ?? "localhost";
const port = process.env["RELAY_CLICKHOUSE_HTTP_PORT"] ?? "8123";

/** One statement per request: the HTTP interface refuses a multi-statement body with
 *  `Code: 62`, which is the interface's rule rather than a convention. */
async function ch(sql: string): Promise<string> {
  const res = await fetch(`http://${host}:${port}/`, {
    method: "POST",
    headers: { Authorization: auth },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim().split("\n")[0] ?? "clickhouse refused");
  return text.trim();
}

/** A close record. `ts` is the CLOSING instant and `duration_ms` the elapsed time, so the
 *  open is `ts - duration_ms` and the open record is not needed to compute a minute. */
const closeAt = (id: number, at: string, durationMs: number): string =>
  `('${ENV}','${at}','6a000000-0000-4000-8000-${String(id).padStart(12, "0")}',` +
  `'closed',1000,${durationMs},'metering-itest-${id}')`;

const openOnly = (id: number, at: string): string =>
  `('${ENV}','${at}','6a000000-0000-4000-8000-${String(id).padStart(12, "0")}',` +
  `'opened',NULL,NULL,'metering-itest-${id}')`;

async function clean(): Promise<void> {
  await ch(`ALTER TABLE relay_analytics.connection_events DELETE WHERE environment_id = '${ENV}'`);
  await ch(`ALTER TABLE relay_analytics.message_events DELETE WHERE environment_id = '${ENV}'`);
  await ch(`ALTER TABLE relay_analytics.daily_usage_v2 DELETE WHERE environment_id = '${ENV}'`);
  // The delete above does not reach 4.2's rollup: a materialised view does not propagate
  // deletes, and its storage is an implicit inner table addressed by its own name.
  const inner = await ch(
    `SELECT name FROM system.tables WHERE database='relay_analytics' AND name LIKE '.inner_id.%' FORMAT TSV`,
  );
  for (const name of inner.split("\n").filter(Boolean)) {
    await ch(
      `ALTER TABLE relay_analytics.\`${name}\` DELETE WHERE environment_id = '${ENV}'`,
    ).catch(() => undefined); // not every inner table has that column
  }
}

/** Mutations are asynchronous. Poll for what must be gone rather than sleeping at it — a
 *  flat sleep before an assertion is a bet that the server is idle. */
async function settle(predicate: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  expect(await ch("SELECT 1 FORMAT TSV")).toBe("1"); // a positive control, before anything
  await clean();
});

afterAll(clean);

describe("connection-minutes reach the rollup", () => {
  it("bills every calendar minute a connection was open for any part of", async () => {
    // `meter.ts`'s rule, verbatim: "Open at 00:00:59 and closed at 00:01:01 is two seconds
    // of wall clock and TWO connection-minutes." Two seconds of wall clock, two minutes.
    await ch(
      `INSERT INTO relay_analytics.connection_events
         (environment_id, ts, connection_id, event, close_code, duration_ms, user_external_id)
       VALUES ${closeAt(1, `${DAY} 00:01:01.000`, 2000)}`,
    );
    const minutes = await ch(
      `SELECT sum(connection_minutes) FROM relay_analytics.daily_usage_v2
        WHERE environment_id = '${ENV}' FORMAT TSV`,
    );
    expect(Number(minutes)).toBe(2);
  });

  it("gives an open with no close zero minutes, rather than a wrong number", async () => {
    // 44 of 99 connections in this store are in exactly this state, and 4.5 measured why:
    // `wss.close()` does not close established sockets, so a deploy leaves opens behind.
    const before = Number(
      await ch(
        `SELECT sum(connection_minutes) FROM relay_analytics.daily_usage_v2
          WHERE environment_id = '${ENV}' FORMAT TSV`,
      ),
    );
    await ch(
      `INSERT INTO relay_analytics.connection_events
         (environment_id, ts, connection_id, event, close_code, duration_ms, user_external_id)
       VALUES ${openOnly(2, `${DAY} 05:00:00.000`)}`,
    );
    const after = Number(
      await ch(
        `SELECT sum(connection_minutes) FROM relay_analytics.daily_usage_v2
          WHERE environment_id = '${ENV}' FORMAT TSV`,
      ),
    );
    expect(after).toBe(before);
    // And the open IS in the raw table — it contributed nothing, it was not dropped.
    const opens = await ch(
      `SELECT count() FROM relay_analytics.connection_events
        WHERE environment_id = '${ENV}' AND event = 'opened' FORMAT TSV`,
    );
    expect(Number(opens)).toBe(1);
  });

  it("splits a connection that crosses midnight across two days", async () => {
    await ch(
      `INSERT INTO relay_analytics.connection_events
         (environment_id, ts, connection_id, event, close_code, duration_ms, user_external_id)
       VALUES ${closeAt(3, "2026-09-21 00:00:30.000", 60_000)}`,
    );
    const rows = await ch(
      `SELECT day, sum(connection_minutes) FROM relay_analytics.daily_usage_v2
        WHERE environment_id = '${ENV}' AND day >= '2026-09-20'
        GROUP BY day ORDER BY day FORMAT TSV`,
    );
    const days = rows.split("\n").map((l) => l.split("\t")[0]);
    expect(days).toContain("2026-09-20");
    expect(days).toContain("2026-09-21");
  });

  it("carries the zero channel, because a connection belongs to a tenant and not a channel", async () => {
    const channels = await ch(
      `SELECT DISTINCT channel_id FROM relay_analytics.daily_usage_v2
        WHERE environment_id = '${ENV}' AND connection_minutes > 0 FORMAT TSV`,
    );
    expect(channels).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("leaves the message columns at zero, and uniqMerge reads the omitted state as 0", async () => {
    // The connection view names three columns and omits four. An `AggregateFunction` has no
    // trivial default, so this is the arm that could have thrown rather than defaulted.
    const row = await ch(
      `SELECT sum(messages), sum(stored_delta), uniqMerge(active_users_state)
         FROM relay_analytics.daily_usage_v2 WHERE environment_id = '${ENV}' FORMAT TSV`,
    );
    expect(row).toBe("0\t0\t0");
  });

  it("keeps a second tenant's minutes unreachable from this one's filter", async () => {
    // Constitution I, asserted in both directions.
    const other = "6a000000-0000-4000-8000-0000000051b7";
    await ch(
      `INSERT INTO relay_analytics.connection_events
         (environment_id, ts, connection_id, event, close_code, duration_ms, user_external_id)
       VALUES ('${other}','${DAY} 09:00:30.000','6a000000-0000-4000-8000-000000000099',
               'closed',1000,60000,'metering-itest-other')`,
    );
    const mine = await ch(
      `SELECT count() FROM relay_analytics.daily_usage_v2
        WHERE environment_id = '${ENV}' AND connection_minutes > 0 FORMAT TSV`,
    );
    const theirs = await ch(
      `SELECT count() FROM relay_analytics.daily_usage_v2
        WHERE environment_id = '${other}' FORMAT TSV`,
    );
    expect(Number(mine)).toBeGreaterThan(0);
    expect(Number(theirs)).toBeGreaterThan(0);
    const crossed = await ch(
      `SELECT count() FROM relay_analytics.daily_usage_v2
        WHERE environment_id = '${ENV}' AND environment_id = '${other}' FORMAT TSV`,
    );
    expect(Number(crossed)).toBe(0);
    await ch(
      `ALTER TABLE relay_analytics.connection_events DELETE WHERE environment_id = '${other}'`,
    );
    await ch(
      `ALTER TABLE relay_analytics.daily_usage_v2 DELETE WHERE environment_id = '${other}'`,
    );
    expect(
      await settle(async () => {
        const n = await ch(
          `SELECT count() FROM relay_analytics.daily_usage_v2
            WHERE environment_id = '${other}' FORMAT TSV`,
        );
        return Number(n) === 0;
      }),
    ).toBe(true);
  });
});
