/** Which routes are moderation, and therefore which actions owe an audit entry
 * (FR-MOD-03, FR-003).
 *
 * A SIBLING OF `isolation/targets.ts`, NOT A FIELD ON IT, and the reason is a
 * measurement. A `moderation` field required on all 47 of that file's entries — required,
 * because *nothing may be exempt by omission* is its own first rule — is 16 diff hunks at
 * the width this series publishes and 510 lines at the width that collapses them, against
 * a 591-line file. A change touching every entry of a list has no economical diff. The
 * argument for coupling them was that two lists can fall out of step with the router
 * independently; they cannot, because both are checked against the same derivation — the
 * routes a booted application reports. What they can drift from is each other, and
 * neither is derived from the other.
 *
 * The second reason arrived while measuring the first: the gauntlet is the suite the
 * constitution names as gating releases, and a compliance classification living in its
 * list means a change to the moderation set turns the isolation suite red.
 *
 * THE KEY IS `METHOD /path`, the same string `targets.ts` builds for a derived route, so
 * the check below is a set comparison rather than a mapping somebody maintains — and the
 * same string goes in `audit_log.action`. One name for the column, the read route's
 * filter and this list.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────
 * HOW AN ACTION IS ADDED TO THE SET
 * ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Three steps, and a check goes red if either of the first two is skipped.
 *
 *   1. CLASSIFY THE ROUTE HERE, with a reason. Every tenant-reachable mutating route the
 *      router serves needs an entry — `moderation`, `moderation-when-application` or
 *      `not-moderation` — and the reason is the part worth reading in a year.
 *      `moderation-routes.itest.ts` boots the application and compares this list against
 *      the routes it derives, in both directions: a derived route with no entry fails,
 *      and an entry naming no derived route fails too. The second direction is the one
 *      that catches a stale entry after a rename, and it is the half a new mechanism
 *      usually forgets.
 *
 *   2. NAME IT IN `ACTION` BELOW and write the entry at the write site, inside the
 *      transaction the action already uses — `repository.ts`'s `recordAction`, after
 *      whatever guard tells the method it changed something. FR-005 wants the entry and
 *      the action to commit or roll back together; FR-008 wants an action that changed
 *      nothing to write nothing. A name that is not a key of `MODERATION_ROUTES` is a
 *      compile error, which was probed both ways rather than assumed.
 *
 *   3. ASSERT IT IN `audit/audit.itest.ts`. Step 1's check proves the route was
 *      CLASSIFIED; nothing structural can prove it was RECORDED, because an entry is
 *      written by code rather than declared by a list. Chapter 4.8 learned the same thing
 *      one registry over: naming a route is not covering it.
 *
 * `packages/protocol/src/codes.ts` is the registry this one is modelled on and keeps its
 * procedure in the file for the same reason — the person adding the next entry is reading
 * the entries, not the chapter.
 * ────────────────────────────────────────────────────────────────────────────────────── */
export type Moderation =
  | "moderation"
  | "moderation-when-application"
  | "not-moderation";

/** Every tenant-reachable mutating route and what it owes.
 *
 * `/internal/` routes are absent and that is not an omission: a platform principal
 * carries no environment (chapter 4.4), so its action cannot be scoped to a tenant and
 * cannot appear in a tenant's read. Outside by construction rather than by decision. */
// `as const satisfies`, NOT `: Readonly<Record<string, Moderation>>`, AND THE
// DIFFERENCE WAS MEASURED. The annotation widens the key type to `string`, so
// `keyof typeof MODERATION_ROUTES` becomes `string` and the check on `ACTION` below
// accepts any string at all. Probed: with the annotation, a deliberate typo in an
// action string typechecked clean. This form keeps the literal keys.
export const MODERATION_ROUTES = {
  // minting a credential is authentication plumbing: it changes nobody's standing and
  // no content
  "POST /auth/dev-token": "not-moderation",
  // creating a space is provisioning
  "POST /v1/channels": "not-moderation",
  // removes a shared space from use for everyone in it
  "POST /v1/channels/:channelId/archive": "moderation",
  // the reversal is as much an action as the action — the ban pair's precedent
  "DELETE /v1/channels/:channelId/archive": "moderation",
  // `accepts: "user"`; the caller acts on themselves
  "POST /v1/channels/:channelId/join": "not-moderation",
  // **the hardest call on this list, and it is excluded.** The rule admits it — a
  // tenant adding somebody else acts on another — but a tenant's onboarding does this
  // all day, and a log that records provisioning is a request log with extra columns
  "POST /v1/channels/:channelId/members": "not-moderation",
  // granting or revoking moderator powers is the thing an audit log exists for
  "PATCH /v1/channels/:channelId/members/:userExternalId": "moderation",
  // an action against a person
  "POST /v1/channels/:channelId/members/remove": "moderation",
  // the product's main verb, under either credential
  "POST /v1/channels/:channelId/messages": "not-moderation",
  // **`accepts: "user"` — a tenant key cannot reach it at all.** FR-MOD-02 grants
  // deletion of any message and is silent on editing, and FR-013a reads silence as
  // absence of permission. The spec expected *edit another author's message* to be the
  // ninth inclusion; it is not an action that exists
  "PATCH /v1/channels/:channelId/messages/:messageId": "not-moderation",
  // FR-002a's one route. Under a key it is FR-MOD-02; under a user token deleting
  // their own message it is chapter 3.23's FR-013, and a compliance log that recorded
  // the second would fill with ordinary user activity
  "DELETE /v1/channels/:channelId/messages/:messageId":
    "moderation-when-application",
  // taking an upload slot is the product's verb
  "POST /v1/media": "not-moderation",
  // upserting users is provisioning
  "POST /v1/users": "not-moderation",
  // removes a person's profile and memberships
  "DELETE /v1/users/:externalId": "moderation",
  // profile maintenance. **The line this set draws is STANDING, not data**: ban,
  // delete, role and removal change what a person may do; a display name does not
  "PATCH /v1/users/:externalId": "not-moderation",
  // FR-MOD-01, and the chapter's opening demonstration
  "POST /v1/users/:externalId/ban": "moderation",
  // FR-MOD-01's reversal, which before this chapter left no trace at all
  "DELETE /v1/users/:externalId/ban": "moderation",
  // a read position is the reader's own state
  "PUT /v1/users/:externalId/channels/:channelId/read": "not-moderation",
  // integration configuration, not moderation
  "POST /v1/webhooks": "not-moderation",
  // integration configuration
  "DELETE /v1/webhooks/:id": "not-moderation",
  // integration configuration
  "POST /v1/webhooks/:id/disable": "not-moderation",
  // integration configuration
  "POST /v1/webhooks/:id/enable": "not-moderation",
  // security-sensitive and **not moderation**; a configuration audit is a clause that
  // does not exist
  "POST /v1/webhooks/:id/rotate-secret": "not-moderation",
  // integration configuration
  "POST /v1/webhooks/:id/test": "not-moderation",
} as const satisfies Record<string, Moderation>;

/** The action strings the repository writes, named so a typo is a compile error rather
 * than an entry nobody can find. Each is a key of `MODERATION_ROUTES` and the type below
 * is what says so. */
export const ACTION = {
  ban: "POST /v1/users/:externalId/ban",
  unban: "DELETE /v1/users/:externalId/ban",
  deleteUser: "DELETE /v1/users/:externalId",
  removeMember: "POST /v1/channels/:channelId/members/remove",
  setMemberRole: "PATCH /v1/channels/:channelId/members/:userExternalId",
  archiveChannel: "POST /v1/channels/:channelId/archive",
  unarchiveChannel: "DELETE /v1/channels/:channelId/archive",
  deleteMessage: "DELETE /v1/channels/:channelId/messages/:messageId",
} as const satisfies Record<string, keyof typeof MODERATION_ROUTES>;
