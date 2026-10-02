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
 * filter and this list. */
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
  "POST /auth/dev-token": "not-moderation",
  "POST /v1/channels": "not-moderation",
  "POST /v1/channels/:channelId/archive": "moderation",
  "DELETE /v1/channels/:channelId/archive": "moderation",
  "POST /v1/channels/:channelId/join": "not-moderation",
  "POST /v1/channels/:channelId/members": "not-moderation",
  "PATCH /v1/channels/:channelId/members/:userExternalId": "moderation",
  "POST /v1/channels/:channelId/members/remove": "moderation",
  "POST /v1/channels/:channelId/messages": "not-moderation",
  "PATCH /v1/channels/:channelId/messages/:messageId": "not-moderation",
  "DELETE /v1/channels/:channelId/messages/:messageId":
    "moderation-when-application",
  "POST /v1/media": "not-moderation",
  "POST /v1/users": "not-moderation",
  "DELETE /v1/users/:externalId": "moderation",
  "PATCH /v1/users/:externalId": "not-moderation",
  "POST /v1/users/:externalId/ban": "moderation",
  "DELETE /v1/users/:externalId/ban": "moderation",
  "PUT /v1/users/:externalId/channels/:channelId/read": "not-moderation",
  "POST /v1/webhooks": "not-moderation",
  "DELETE /v1/webhooks/:id": "not-moderation",
  "POST /v1/webhooks/:id/disable": "not-moderation",
  "POST /v1/webhooks/:id/enable": "not-moderation",
  "POST /v1/webhooks/:id/rotate-secret": "not-moderation",
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
