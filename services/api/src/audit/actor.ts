import type { RequestWithTenant } from "../messages/request-with-tenant";

/** Who made the request, and which request it was (FR-MOD-03).
 *
 * THE TWO FIELDS THE AUDIT LOG CANNOT DERIVE. Everything else an entry holds is known at
 * the write site — what the action was, what it acted on, when. The actor and the request
 * id are facts about the HTTP request, and a repository method has never been told either.
 *
 * `id` is the identifier a customer could recognise: the key id for an application
 * credential, the external id for a user, and **null for a platform principal**, which
 * carries no tenant and therefore no identifier a tenant could read. */
export interface ActorContext {
  kind: "application" | "user" | "platform";
  id: string | null;
  requestId: string;
}

/** What a construction site supplies when it will never record an entry.
 *
 * A NAMED VALUE AND NOT AN OMISSION, because *nothing may be exempt by omission* is the
 * rule `isolation/targets.ts` already states, and an exemption list is what this project
 * refuses (056-10). One production site records nothing — `auth/dev-token.controller.ts`,
 * which mints a credential and performs no moderation action — and the difference between
 * that site and a site that forgot has to be visible to a check. It is:
 * `db/repository.itest.ts` reads every production `new Repository(` and requires one or
 * the other.
 *
 * NOT `?? ""`. `environmentId` already does that, and chapter 4.4 recorded what an empty
 * string costs — a value that keeps compiling and keeps meaning nothing. */
export const RECORDS_NOTHING = "records-nothing" as const;

/** The principal and the request id, in the one shape the repository stores.
 *
 * THE THREE KINDS MAP WITHOUT A LOOKUP, which is why this is a function and not a join:
 * an application credential is its key id, a user is their external id, and a platform
 * principal is null because it carries no tenant at all (chapter 4.4). Each identifier is
 * already on the principal the guard resolved.
 *
 * Called by the five request-scoped `Repository` factories — `users`, `channels`,
 * `media`, `messages` and `webhooks` modules — on every request they serve. */
export function actorFrom(req: RequestWithTenant): ActorContext | undefined {
  const p = req.principal;
  const requestId = req.requestId;
  // A REQUEST WITHOUT A PRINCIPAL NEVER REACHES A CONTROLLER, so this is not a case the
  // platform can be in — it is the factory running before the guard in a test that builds
  // one by hand. Returning `undefined` rather than inventing an actor keeps the entry
  // unwritable instead of writing a wrong one.
  if (p === undefined || requestId === undefined) return undefined;
  return {
    kind: p.kind,
    id:
      p.kind === "application"
        ? p.keyId
        : p.kind === "user"
          ? p.userExternalId
          : null,
    requestId,
  };
}
