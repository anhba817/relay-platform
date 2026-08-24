/** The indistinguishability oracle.
 *
 * LIFTED FROM `messages/messages.itest.ts`, WHERE IT WAS WRITTEN AND WHERE IT WAS
 * RIGHT. Chapter 2.2's suite needed to prove that a foreign channel answers exactly
 * as an absent one; `request_id` on every error body is what forced this helper into
 * existence, and the error-registry chapter is what put it there; and there it stayed —
 * one file's private
 * function doing the thing constitution I asks of every endpoint.
 *
 * A correct assertion written once and never generalised is what separates scattered
 * isolation tests from a suite. It lives here so every route can share it, and
 * `messages.itest.ts` imports it back.
 *
 * `request_id` is unique per request BY DESIGN, so two error bodies can no longer be
 * compared whole — and comparing them whole is how a suite proves a foreign resource
 * is indistinguishable from an absent one, which is a tenant-isolation property
 * (constitution I).
 *
 * The id is the one field that reveals nothing about the resource, so it is the one
 * field the comparison must drop. Everything discriminating still has to match
 * exactly.
 *
 * WHY IT ARRIVES IN THIS CHAPTER AND NOT WITH THE HARNESS. The isolation harness
 * owns it by subject — `chapter-map.json` lists it there — and that chapter's page
 * never fenced it, so it was assigned to a chapter and delivered by none. It is here
 * because this is the first chapter whose tests cannot be written without it: three
 * of them compare a private channel's refusal against an absent channel's, and the
 * bodies differ by exactly this field. A file belongs to the chapter that creates it. */
export function withoutRequestId(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete rest["request_id"];
  return rest;
}
