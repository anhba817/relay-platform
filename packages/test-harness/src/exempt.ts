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

export const EXEMPT_FILES: ReadonlyArray<{ path: string; because: string }> = [
  {
    path: "services/api/src/outbox/outbox.itest.ts",
    because: "drives the event relay, whose whole subject is a global drain",
  },
  {
    path: "services/api/src/webhooks/deliveries.itest.ts",
    because: "drives both the sweep and the due-delivery drain",
  },
  {
    path: "services/api/src/webhooks/test-event.itest.ts",
    because: "drives the delivery relay",
  },
  {
    path: "services/api/src/webhooks/attempts.itest.ts",
    because: "drives the delivery relay",
  },
  {
    path: "services/api/src/notifications/notifications.itest.ts",
    because: "drives the notification relay",
  },
  {
    path: "services/dispatcher/src/dispatcher.itest.ts",
    because: "drives the due-delivery drain from the dispatcher's side",
  },
];

/** Is this file allowed to perform global operations?
 *
 * Matched on a repository-relative path suffix, because the same file is reached
 * as `src/outbox/outbox.itest.ts` from the api's config and as
 * `services/api/src/outbox/outbox.itest.ts` from the root coverage config. */
export function isExempt(testPath: string): boolean {
  const normalised = testPath.replace(/\\/g, "/");
  return EXEMPT_FILES.some((e) => normalised.endsWith(e.path));
}
