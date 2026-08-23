/** The indistinguishability oracle (chapter 3.12).
 *
 * LIFTED FROM `messages/messages.itest.ts`, WHERE IT WAS WRITTEN AND WHERE IT WAS
 * RIGHT. Chapter 2.2's suite needed to prove that a foreign channel answers exactly
 * as an absent one, chapter 3.8 added `request_id` to every error body and forced
 * this helper into existence, and there it stayed — one file's private function
 * doing the thing constitution I asks of every endpoint.
 *
 * That is the difference this chapter is about. A correct assertion written once and
 * never generalised is what separates nine scattered isolation tests from a suite.
 * It lives here so 24 routes can share it; `messages.itest.ts` imports it back.
 *
 * Chapter 3.8 added `request_id` to every error body (constitution V's fourth
 * field, promised since 1.3). It is unique per request BY DESIGN, so two error
 * bodies can no longer be compared whole — and comparing them whole is how a suite
 * proves a foreign resource is indistinguishable from an absent one, which is a
 * tenant-isolation property (constitution I).
 *
 * The id is the one field that reveals nothing about the resource, so it is the
 * one field the comparison must drop. Everything discriminating still has to
 * match exactly. */
export function withoutRequestId(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete rest["request_id"];
  return rest;
}
