/** What a usage report is worth, in one function (chapter 3.11, FR-006/FR-007).
 *
 * A report says what a connection has consumed IN TOTAL in a period, not what it
 * consumed since the last report. Everything the protocol gets from that
 * decision reduces to this line:
 *
 *   - a report delivered twice credits nothing the second time
 *   - a report that was lost is repaid by the next one, which carries the same
 *     total plus whatever accrued since
 *   - two reports that arrive out of order credit the higher one and leave the
 *     figure alone for the lower
 *
 * PURE, AND SEPARATE FROM THE TRANSACTION THAT USES IT, because those three
 * properties are the chapter's argument and each is one line to test here and a
 * database round trip to test anywhere else. Chapter 3.6 separated `disable.ts`
 * for the same reason and chapter 3.8 separated `bucket.ts`.
 *
 * `credited` is what the accounting row already holds; `reported` is what the
 * gateway now claims. Neither is ever negative — the schema refuses that at the
 * door and the CHECK refuses it at the table — but the `max` is here rather than
 * assumed, because the one thing this function must never do is subtract from a
 * bill. */
export function creditFor(reported: number, credited: number): number {
  return Math.max(0, reported - credited);
}

/** The new stored total after crediting. `greatest`, not `reported`, so a report
 * that arrives late and low cannot walk a figure backwards. */
export function highWaterMark(reported: number, credited: number): number {
  return Math.max(reported, credited);
}
