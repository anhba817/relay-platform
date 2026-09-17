/** FR-ANL-07's query surface, as arithmetic (chapter 4.8).
 *
 * EVERYTHING HERE RUNS WITH NO STORE, NO DATABASE AND NO BROKER, which is the shape
 * chapter 4.7 separated `exitCodeFor` for: a contract with branches a test can drive is
 * worth more than one that needs Docker. The reader and the route come next; what this
 * file owns is what the caller is allowed to have asked for.
 */
import { z } from "zod";

/** The value that names the request the router matched nothing for.
 *
 * NOT A ROUTE, AND THAT IS WHY IT HAS TO BE SPELLED. The accepted endpoint set is derived
 * from the running router (below), and the router contains no entry for a request that
 * matched none of its entries — so the most diagnostic question a 404 investigation asks
 * would have been the one question the filter could not express. 32 rows carry
 * `endpoint IS NULL` in the lane today.
 *
 * It cannot collide with a derived route: every route template this api registers begins
 * with `/`. */
export const UNMATCHED = "unmatched";

/** FR-ANL-07 retains thirty days. DR-09's ninety is the raw-event figure and this table is
 * not raw events — `analytics/0005_connection_events.sql:4` states the reason one clause
 * cannot express two, and `SHOW CREATE` reports `toDateTime(ts) + toIntervalDay(30)`. */
export const RETENTION_DAYS = 30;

/** The default window when the caller names neither end. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** An ISO-8601 instant, as a `Date`.
 *
 * THE TYPE IS THE GUARD, AND THIS IS THE LINE THAT MAKES IT ONE. `AnalyticalStore.query`
 * takes a SQL string and has no parameter binding (R9), so the defence against a hostile
 * window cannot be escaping — it is that nothing downstream ever holds the caller's text.
 * What leaves this schema is a `Date`, and `clickHouseInstant` below is the only function
 * that turns one into SQL. There is no path from a query string to a statement.
 *
 * `offset: true` accepts `+07:00` as well as `Z`; both are instants. A bare `2026-09-16`
 * is refused, because a date is not an instant and the surface would have to invent a
 * timezone to make one. */
const instant = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v))
  /** The belt beside the braces. `z.iso.datetime` refuses `2026-13-45T00:00:00Z`; this
   * catches anything that parses as a string and not as a moment, and costs one call. */
  .refine((d) => !Number.isNaN(d.getTime()), { message: "not a valid instant" });

/** The query schema, built against the endpoint set the running router reports.
 *
 * A FACTORY BECAUSE THE CLOSED SET IS NOT KNOWN AT IMPORT TIME. `deriveTargets` reads
 * `app.getHttpAdapter().getInstance()` — the cross-tenant suite's own mechanism
 * (`isolation/targets.ts`) — so the set exists only once the application is built. Passing
 * it in is also what lets every refusal in this file be unit-tested against a set of three.
 *
 * `z.strictObject`, MIRRORING `historyQuerySchema` (`messages/messages.schema.ts`) IN FORM
 * AND BOUNDS — 1..200, default 50, `older`/`newer`. Strict is the half that is easy to
 * drop: a plain `z.object` accepts `limt=200` silently and serves the default 50, so a
 * caller's typo becomes a wrong answer rather than a 400. Mirrored rather than moved to a
 * shared module: that file carries six titled fences in each locale and is clean in the
 * fence chain, and relocating a four-line shape would cost twelve hunks. */
export function buildRequestLogQuerySchema(endpoints: ReadonlySet<string>) {
  return z
    .strictObject({
      /** INCLUSIVE. Absent means `to - 24h`; clamped to the retention edge rather than
       * refused, because a caller asking for ninety days is asking a reasonable question
       * the data cannot answer (R8, and FR-ANL-08 says 90 where FR-ANL-07 retains 30). */
      from: instant.optional(),
      /** EXCLUSIVE, and the half-open range is chapter 4.7's precedent. There a
       * reconciler's off-by-one reports drift; here it duplicates a row across two pages,
       * because the row on the boundary belongs to both windows. Absent means now. */
      to: instant.optional(),
      cursor: z.string().min(1).optional(),
      direction: z.enum(["older", "newer"]).default("older"),
      /** REFUSED OUT OF BOUNDS, NOT CLAMPED — see `resolveWindow` for the field that is
       * clamped instead, and why the two differ. */
      limit: z.coerce.number().int().min(1).max(200).default(50),
      /** A MEMBER OF A CLOSED SET DERIVED FROM THE ROUTER, or `unmatched`. A value from a
       * derived set is not text reaching SQL; an unknown one is a 400 rather than an empty
       * page, which is the same distinction the retention edge draws between "nothing
       * matched" and "this question cannot be answered". */
      endpoint: z
        .string()
        .refine((v) => v === UNMATCHED || endpoints.has(v), {
          message: "unknown endpoint",
        })
        .optional(),
      /** `status` is `UInt16` in the store and an HTTP status here: the column's range is
       * wider than the protocol's, and the narrower of the two is the honest bound. */
      status: z.coerce.number().int().min(100).max(599).optional(),
    })
    .superRefine((q, ctx) => {
      // `to` is exclusive, so equal ends describe a window that can hold nothing. A
      // caller who wrote them is asking for something they did not mean.
      if (q.from && q.to && q.to.getTime() <= q.from.getTime()) {
        ctx.addIssue({
          code: "custom",
          path: ["to"],
          message: "`to` must be after `from`",
        });
      }
    });
}

export type RequestLogQuerySchema = ReturnType<typeof buildRequestLogQuerySchema>;
export type RequestLogQuery = z.infer<RequestLogQuerySchema>;

/** The window a page is actually read over. */
export interface ResolvedWindow {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  /** `now - RETENTION_DAYS`, the nominal guarantee, reported to the caller. */
  retentionEdge: Date;
  /** `from` was older than the edge and was moved forward. */
  clamped: boolean;
  /** The whole requested window is older than the edge, so it can hold nothing. The
   * reader skips the store for this: a query that cannot return a row should not cost
   * one. */
  empty: boolean;
}

/** Apply the defaults and the retention edge.
 *
 * `now` IS A PARAMETER. Every bound here is relative to it, and a function that reads the
 * clock has no boundary a test can sit on — chapter 4.7's reconciler paid for the same
 * thing in the other direction, where the smallest breaching drift had to be computable.
 *
 * WHY `from` IS CLAMPED WHERE `limit` IS REFUSED, which is the one asymmetry on this
 * surface and is a decision rather than an accident. `limit`'s bound is published in the
 * contract, so a caller outside it has made a mistake they can see and fix, and a 400 says
 * which field. The retention edge is a property of the store that moves every second and
 * is published as a guarantee rather than as a bound — a caller cannot know it when they
 * write the request, so refusing them for missing it would refuse a reasonable question.
 * They get the window the data can answer for, and `retention_edge` beside it. */
export function resolveWindow(
  query: Pick<RequestLogQuery, "from" | "to">,
  now: Date,
  retentionDays: number = RETENTION_DAYS,
): ResolvedWindow {
  const retentionEdge = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const to = query.to ?? now;
  const requestedFrom = query.from ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  const clamped = requestedFrom.getTime() < retentionEdge.getTime();
  const from = clamped ? retentionEdge : requestedFrom;
  // A window whose exclusive end is at or before its inclusive start holds nothing. It
  // arrives here one way only: the caller asked for a period entirely older than the
  // edge, and the clamp moved `from` past `to`. It is NOT a refusal — the answer "that
  // is gone" is the one R8 exists to give, and the caller reads it off `window` and
  // `retention_edge` rather than off an empty page that could also mean a quiet day.
  const empty = from.getTime() >= to.getTime();
  return { from: empty ? to : from, to, retentionEdge, clamped, empty };
}

/** The only function that turns an instant into SQL.
 *
 * `DateTime64(3)` — milliseconds, and the store parses `YYYY-MM-DD hh:mm:ss.SSS` in the
 * column's own timezone, so the value is rendered from the UTC parts rather than through
 * a locale-dependent formatter. Takes a `Date` and not a string, which is the whole of the
 * injection argument: there is nothing to escape because there is nothing to quote. */
export function clickHouseInstant(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}
