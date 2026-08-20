// The files permitted to perform global operations (feature 030, FR-009, FR-015).
//
// A LIST OF PATHS, EACH WITH ITS REASON. Not a pattern: a pattern silently absorbs
// the next file added, which is the failure mode this whole feature is about.
//
// An exempt file is not excused from correctness. It is excused from the trigger,
// and it still has to bound its own batches — which is what four of the six
// recorded instances failed to do while being, in this sense, legitimate.
//
// This list and `eslint.config.mjs`'s ignores for the global-admin functions must
// agree. A file exempt from one and not the other is a trap for whoever adds the
// seventh.
//
// EACH ENTRY NAMES THE TABLES, NOT JUST THE FILE. The first version exempted whole
// files, and it could not catch the fault it was built for: instance 6 lives in
// `notifications.itest.ts`, which is on this list because it drives the
// notification relay — a legitimately global operation on
// `webhook_disable_notifications`. A file-wide pass let the same file sweep
// `webhook_endpoints` globally too, which is what instance 6 did. Reintroducing it
// under a file-wide exemption passed nine tests out of nine (research R41).
//
// So the same argument that made this a list of paths rather than a pattern makes
// each path a list of tables rather than a blanket: whatever silently absorbs the
// next case is the thing to remove.

export const EXEMPT_FILES: ReadonlyArray<{
  path: string;
  /** The guarded tables this file may write across environments. Everything else
   * is still refused, in this file as in any other. Guarded tables are the five in
   * `sentinel.sql`; `outbox` is not among them and needs no entry. */
  tables: readonly string[];
  because: string;
}> = [
  {
    path: "services/api/src/outbox/outbox.itest.ts",
    tables: [],
    because: "drives the event relay, whose whole subject is a global drain",
  },
  {
    path: "services/api/src/webhooks/deliveries.itest.ts",
    tables: [
      "webhook_endpoints",
      "webhook_deliveries",
      "webhook_disable_notifications",
    ],
    because: "drives both the sweep and the due-delivery drain",
  },
  {
    path: "services/api/src/webhooks/test-event.itest.ts",
    tables: ["webhook_deliveries"],
    because: "drives the delivery relay",
  },
  {
    path: "services/api/src/webhooks/attempts.itest.ts",
    tables: ["webhook_deliveries"],
    because: "drives the delivery relay",
  },
  {
    path: "services/api/src/notifications/notifications.itest.ts",
    tables: ["webhook_disable_notifications"],
    because: "drives the notification relay",
  },
  {
    path: "services/dispatcher/src/dispatcher.itest.ts",
    tables: ["webhook_deliveries"],
    because: "drives the due-delivery drain from the dispatcher's side",
  },
];

/** Which guarded tables may this file write across environments — or `null` if it
 * is not on the list at all. An empty array is a real answer and not the same as
 * `null`: `outbox.itest.ts` is here on purpose, and needs no guarded table.
 *
 * Matched on a repository-relative path suffix, because the same file is reached
 * as `src/outbox/outbox.itest.ts` from the api's config and as
 * `services/api/src/outbox/outbox.itest.ts` from the root coverage config. */
export function exemptTables(testPath: string): readonly string[] | null {
  const normalised = testPath.replace(/\\/g, "/");
  return EXEMPT_FILES.find((e) => normalised.endsWith(e.path))?.tables ?? null;
}

/** Is this file on the list? Kept separate from `exemptTables` because the two
 * questions have different answers for `outbox.itest.ts`. */
export function isExempt(testPath: string): boolean {
  return exemptTables(testPath) !== null;
}
