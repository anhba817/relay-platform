import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { AnalyticalStoreError, type AnalyticalStore } from "../metering/clickhouse";
import { createRequestLogReader } from "./reader";
import { buildRequestLogQuerySchema } from "./request-log.schema";

// The reader's REFUSAL arms, which the integration suite cannot reach.
//
// FOUND BY THE BRANCH REPORT RATHER THAN BY READING. `reader.ts` measured 94.59 / 79.24
// against `query.itest.ts` and `route.itest.ts`, naming two lines — and both are decisions
// this chapter argued for in a comment and never asserted. A comment explaining a branch
// nobody drives is the shape chapter 4.6 found twice in one file.

const schema = buildRequestLogQuerySchema(new Set(["/v1/request-log"]));

const storeThatThrows = (error: unknown): AnalyticalStore => ({
  query: () => Promise.reject(error),
});

const statusOf = (e: unknown) => (e instanceof HttpException ? e.getStatus() : null);
const codeOf = (e: unknown) =>
  e instanceof HttpException
    ? (e.getResponse() as { code?: string }).code
    : null;

const ENV = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";

describe("what the reader does with a store that refuses", () => {
  /** THE TWO CASES ARE TOLD APART BY WHOSE FAULT IT IS, and that is the whole of the
   * mapping. A timeout or no answer is the analytical pipeline being unavailable while
   * the api is up — constitution III's second clause — and the client should retry. */
  it.each([
    ["a timeout", 408],
    ["no answer at all — abort, refused connection, DNS", 0],
  ])("answers 503 analytics_unavailable for %s", async (_name, status) => {
    const reader = createRequestLogReader(
      storeThatThrows(new AnalyticalStoreError("Code: 159. DB::Exception: …", status)),
    );
    const thrown = await reader
      .page(ENV, schema.parse({}))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(statusOf(thrown)).toBe(503);
    expect(codeOf(thrown)).toBe("analytics_unavailable");
    expect(String((thrown as HttpException).message)).not.toContain("DB::Exception");
  });

  /** AND ANYTHING ELSE IS OUR STATEMENT BEING WRONG. A 404 from ClickHouse is an unknown
   * identifier and a 400 is a syntax error — the platform's bug, not the store's outage.
   * Telling a customer to retry a query that will never work is worse than telling them
   * nothing, so these propagate and land as `internal_error` with the request id a
   * support ticket quotes. */
  it.each([
    ["an unknown identifier", 404],
    ["a syntax error", 400],
  ])("re-throws %s rather than calling the store unavailable", async (_name, status) => {
    const original = new AnalyticalStoreError("Code: 47. Unknown expression …", status);
    const reader = createRequestLogReader(storeThatThrows(original));
    const thrown = await reader
      .page(ENV, schema.parse({}))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(thrown).toBe(original);
    expect(thrown).not.toBeInstanceOf(HttpException);
  });

  it("refuses a cursor it did not mint, before the store is asked", async () => {
    let asked = false;
    const reader = createRequestLogReader({
      query: () => {
        asked = true;
        return Promise.resolve([]);
      },
    });
    const thrown = await reader
      .page(ENV, schema.parse({ cursor: "not-one-of-ours" }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(statusOf(thrown)).toBe(400);
    expect((thrown as HttpException).getResponse()).toMatchObject({ field: "cursor" });
    // AND NEVER A SILENT FALL BACK TO THE TOP OF THE WINDOW, which would serve a page the
    // caller did not ask for and look like working software. The store is not asked at
    // all, which is the strongest form of that claim.
    expect(asked).toBe(false);
  });
});
