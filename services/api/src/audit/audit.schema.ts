/** FR-006's query surface, as arithmetic (chapter 4.18).
 *
 * EVERYTHING HERE RUNS WITH NO DATABASE, which is the shape chapter 4.7 separated
 * `exitCodeFor` for and chapter 4.8 reused: what this file owns is what the caller is
 * allowed to have asked for. */
import { z } from "zod";

/** The default window when the caller names neither end. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** An ISO-8601 instant, as a `Date`.
 *
 * `offset: true` accepts `+07:00` as well as `Z`; both are instants. A bare `2026-10-02`
 * is refused, because a date is not an instant and the surface would have to invent a
 * timezone to make one. Copied from `request-log.schema.ts` rather than shared: that file
 * carries titled fences in each locale and relocating a four-line shape would cost hunks
 * in both, which is the trade it recorded when it copied the bounds from
 * `historyQuerySchema`. */
const instant = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v))
  .refine((d) => !Number.isNaN(d.getTime()), { message: "not a valid instant" });

/** The query schema, built against the action vocabulary this request may use.
 *
 * A FACTORY, FOR CHAPTER 4.8's REASON AND ONE MORE OF THIS CHAPTER'S OWN.
 *
 * 4.8's: a vocabulary frozen at import time drifts from the router that produces the
 * values, silently and in the direction that matters — a real action becomes unfilterable.
 *
 * AND THIS CHAPTER'S: **an action, once recorded, stays in the vocabulary.** A route
 * reclassified out of the moderation set leaves entries behind carrying an action the
 * current set no longer names, and a filter built from the set alone would refuse a value
 * that exists in the data. So the caller passes the union of the classified set and the
 * distinct actions the column holds. Chapter 4.8 met this from the other side and kept
 * `unmatched` in its set for it: a filter narrower than the table is a question the
 * customer can see the answer to and cannot ask. */
export function buildAuditQuerySchema(actions: ReadonlySet<string>) {
  return z
    .strictObject({
      /** INCLUSIVE. Absent means `to - 24h`.
       *
       * AND NOT CLAMPED, WHICH IS WHERE THIS SURFACE DIVERGES FROM THE REQUEST LOG'S.
       * That one clamps `from` to a retention edge because its table has a 30-day TTL.
       * Nothing prunes this table, so there is no edge to clamp to and no honest value to
       * publish beside the window — a caller asking for last year gets last year, which
       * is likely empty today and will not always be. */
      from: instant.optional(),
      /** EXCLUSIVE, and the half-open range is chapter 4.7's precedent. There a
       * reconciler's off-by-one reports drift; here it duplicates a row across two pages,
       * because the row on the boundary belongs to both windows. Absent means now. */
      to: instant.optional(),
      cursor: z.string().min(1).optional(),
      /** REFUSED OUT OF BOUNDS, NOT CLAMPED: the bound is published in the contract, so a
       * caller outside it has made a mistake they can see and a 400 says which field.
       * 1..200 default 50, matching the request log's and `historyQuerySchema`'s. */
      limit: z.coerce.number().int().min(1).max(200).default(50),
      /** A MEMBER OF THE VOCABULARY THIS REQUEST WAS BUILT WITH. An unknown one is a 400
       * naming the field rather than an empty page — the same distinction between "nothing
       * matched" and "that question cannot be answered". */
      action: z
        .string()
        .refine((v) => actions.has(v), { message: "unknown action" })
        .optional(),
    })
    .superRefine((q, ctx) => {
      // `to` is exclusive, so equal ends describe a window that can hold nothing. A caller
      // who wrote them is asking for something they did not mean.
      if (q.from && q.to && q.to.getTime() <= q.from.getTime()) {
        ctx.addIssue({
          code: "custom",
          path: ["to"],
          message: "`to` must be after `from`",
        });
      }
    });
}

export type AuditQuerySchema = ReturnType<typeof buildAuditQuerySchema>;
export type AuditQuery = z.infer<AuditQuerySchema>;

/** The window a page is actually read over.
 *
 * `now` IS A PARAMETER, for the reason chapter 4.8 gives: every bound here is relative to
 * it, and a function that reads the clock has no boundary a test can sit on.
 *
 * NO RETENTION EDGE AND NO `clamped`, WHICH IS TWO FIELDS FEWER THAN THE PRECEDENT'S. Both
 * exist there because that table expires rows; this one does not, and publishing a
 * boundary this platform does not enforce would be worse than publishing none. FR-MOD-03
 * asks for a year of retention and nothing prunes at a year either — recorded as a gap
 * rather than answered with a field. */
export function resolveWindow(
  query: Pick<AuditQuery, "from" | "to">,
  now: Date,
): { from: Date; to: Date } {
  const to = query.to ?? now;
  const from = query.from ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  return { from, to };
}
