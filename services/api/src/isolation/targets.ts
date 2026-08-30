/** The gauntlet's target list (NFR-SEC-09).
 *
 * A LIST OF CLASSIFICATIONS, NOT A LIST OF TARGETS. The targets themselves are derived
 * from the running application — `app.getHttpAdapter().getInstance().router.stack` —
 * because the fault this suite exists to prevent is a route that exists and is
 * unattacked, and only the router knows what exists. What lives here is the decision
 * about each one, which no derivation can make.
 *
 * NOTHING MAY BE EXEMPT BY OMISSION. A derived target matching no entry fails the
 * suite, and an entry matching no derived target fails it too — the second direction is
 * the one that catches a stale exemption after a rename. That pair of assertions is the
 * whole mechanism. */

/** What kind of attack a route takes.
 *
 * `credential` is the shape a foreign-identifier attack cannot express. `POST
 * /auth/dev-token` accepts no tenant-owned identifier, so there is nothing to put in
 * one — and it is tenant-scoped all the same, because the key it accepts resolves to
 * exactly one environment. Filing it as `exempt` is how a route stops being attacked
 * while looking accounted for. */
export type Shape = "read" | "write" | "credential" | "list" | "exempt";

/** Which credential class the route accepts, and therefore which attack applies.
 *
 * NOT IN `data-model.md` §2, and added here because T031 and T031a need it. The
 * internal surface is two credential classes: three routes take an end-user token,
 * which IS scoped to one environment, so a foreign credential is the attack; five
 * take a platform credential, which carries no environment, so the attack is a
 * request naming one environment with an identifier from another. A `write` shape
 * alone cannot tell those apart, and an earlier draft of this chapter gave all
 * eight the platform attack (research R5). */
/** And `"either"`, added by the channel-control chapter for the first route that genuinely takes both
 * (FR-017's read position: a user records their own, and the tenant records one for the
 * user it names). Recording it as `"user"` alone would understate which attacks apply —
 * both do, and `PUT /v1/users/:externalId/channels/:channelId/read` is attacked with a
 * user token in the gauntlet's same-tenant block and with a tenant credential in T082a's
 * two-identifier pair.
 *
 * This field is documentation for which attack applies, not part of the match:
 * `targetKey` is method and path. So a wrong value here misleads a reader rather than
 * letting a route through unattacked — which is why the value is stated exactly. */
export type CredentialClass =
  | "application"
  | "user"
  | "either"
  | "platform"
  | "none";

interface Classified {
  method: string;
  path: string;
  accepts: CredentialClass;
}

/** `exempt` requires a reason. The type is what makes that true — an exemption with no
 * argument beside it is indistinguishable from an oversight six months later. */
export type Classification =
  | (Classified & { shape: Exclude<Shape, "exempt">; because?: string })
  | (Classified & { shape: "exempt"; because: string });

/** Every route the api serves, as the derivation reports it: 9 today.
 *
 * The shapes sum to 9 — 3 exempt, 2 credential, 1 read, 3 write — and that sum is
 * asserted against the derivation rather than written down twice. A count nobody
 * recomputes is a count that stops being true quietly.
 *
 * THIS LIST GROWS WITH THE PLATFORM. Every chapter after this one that adds a route
 * adds a row here, and the suite goes red until it does. That is the point of building
 * the gauntlet now rather than at the end: a target list written after the fact is a
 * list somebody reconstructs from memory, and the routes it forgets are exactly the
 * ones nobody was thinking about. */
export const CLASSIFICATIONS: readonly Classification[] = [
  // ── exempt: no tenant-owned identifier and no tenant-scoped credential ──────────
  {
    method: "GET",
    path: "/healthz",
    accepts: "none",
    shape: "exempt",
    because:
      "liveness only. No credential, no identifier, and the body is a service name and an uptime.",
  },
  {
    method: "GET",
    path: "/auth/:provider/start",
    accepts: "none",
    shape: "exempt",
    because:
      "pre-tenant. `:provider` names an identity provider, not anything a tenant owns, and the caller has no credential yet — this is the route that gets them one.",
  },
  {
    method: "GET",
    path: "/auth/:provider/callback",
    accepts: "none",
    shape: "exempt",
    because:
      "pre-tenant, and the route that CREATES the tenant. There is no second tenant to reach across from, because at this point the caller belongs to none.",
  },

  // ── credential: tenant-scoped, but with nothing to put a foreign id into ────────
  {
    method: "POST",
    path: "/auth/dev-token",
    accepts: "application",
    shape: "credential",
    because:
      "the body names no tenant-owned resource, so a foreign-identifier attack has nothing to express. It is tenant-scoped all the same: the key it accepts resolves to exactly one environment, and the token it mints must not outlive that scope.",
  },

  // ── the public message surface: attacked as both classes, because it takes both ─
  {
    method: "POST",
    path: "/v1/channels/:channelId/messages",
    accepts: "either",
    shape: "write",
  },
  // ── list ────────────────────────────────────────────────────────────────────
  //
  // THE FOURTH SHAPE, AND THE FIRST ROUTE THAT NEEDS IT. A `list` and not a `read`:
  // the attack on a listing is that a
  // foreign identifier returns somebody else's rows, and the refusal that matters is
  // an EMPTY page rather than an error — a 404 for a foreign user id is right here
  // because the user is named in the path, but the shape's own assertion is that no
  // row from another environment ever appears in a 200.
  {
    method: "GET",
    path: "/v1/users/:externalId/channels",
    accepts: "application",
    shape: "list",
  },

  // The bulk upsert and the deletion. Both `write`: the upsert's attack is
  // an entry naming another tenant's user, which must create a NEW row in the caller's
  // environment rather than touch theirs; the deletion's is a foreign external id, which
  // must answer 404 and leave the other tenant's user alive.
  { method: "POST", path: "/v1/users", accepts: "application", shape: "write" },
  {
    method: "DELETE",
    path: "/v1/users/:externalId",
    accepts: "application",
    shape: "write",
  },

  // The ban pair, both `write`. The attack is a foreign external id: a
  // tenant must not be able to ban another tenant's user, and the refusal is the 404 a
  // user who does not exist in THIS environment gets — which is what they are.
  {
    method: "POST",
    path: "/v1/users/:externalId/ban",
    accepts: "application",
    shape: "write",
  },
  {
    method: "DELETE",
    path: "/v1/users/:externalId/ban",
    accepts: "application",
    shape: "write",
  },

  // The profile pair. `read` for the GET; the PATCH is a `write` whose
  // attack is a foreign external id under an own credential — a tenant must not be able
  // to rename another tenant's user, and the refusal is the same 404 a user who does not
  // exist gets, because in this tenant they do not.
  {
    method: "GET",
    path: "/v1/users/:externalId",
    accepts: "application",
    shape: "read",
  },
  {
    method: "PATCH",
    path: "/v1/users/:externalId",
    accepts: "application",
    shape: "write",
  },

  // The route that names TWO tenant-owned identifiers, which is why
  // T082a attacks it both ways round: a foreign user with an own channel and an own
  // user with a foreign channel are different code paths, and one scoped read can mask
  // the other.
  //
  // `either` because a user records their own position and the tenant records one for
  // the user it names — the only route on the users controller that takes both.
  {
    method: "PUT",
    path: "/v1/users/:externalId/channels/:channelId/read",
    accepts: "either",
    shape: "write",
  },

  // ── read ────────────────────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/v1/channels/:channelId/messages",
    accepts: "either",
    shape: "read",
  },

  // ── the two routes this chapter adds, and the ORDER MATTERS ────────────────────
  //
  // The derivation found them before this list did. `targets.itest.ts` went from 9
  // targets to 11 and named both as unclassified, on the build that registered the
  // module and before anything here mentioned them. That is the failure the derivation
  // exists to produce, and the classification is what changed in answer to it — never
  // the derivation.
  { method: "POST", path: "/v1/channels", accepts: "application", shape: "write" },
  {
    method: "POST",
    path: "/v1/channels/:channelId/members",
    accepts: "application",
    shape: "write",
  },
  // The channel-control chapter's two, and the derivation found them the same way it found the
  // pair above: the lane went red naming both as unclassified on the build that
  // added them, before this file mentioned either. Written with the ROUTER'S
  // parameter names — `:channelId`, not the contracts' `:externalId` — because the
  // derivation compares literal path strings and an entry copied from a contract
  // matches no target.
  //
  // `accepts: "user"` on the join: it is the caller joining, not the tenant adding
  // somebody, and the route carries a method-level `@Accepts("user")` that overrides
  // the controller's class-level `"application"`.
  { method: "GET", path: "/v1/channels/:channelId", accepts: "application", shape: "read" },
  { method: "POST", path: "/v1/channels/:channelId/join", accepts: "user", shape: "write" },
  { method: "POST", path: "/v1/channels/:channelId/members/remove", accepts: "application", shape: "write" },
  { method: "PATCH", path: "/v1/channels/:channelId/members/:userExternalId", accepts: "application", shape: "write" },
  { method: "POST", path: "/v1/channels/:channelId/archive", accepts: "application", shape: "write" },
  { method: "DELETE", path: "/v1/channels/:channelId/archive", accepts: "application", shape: "write" },

  // ── the internal surface: an end-user token, so a FOREIGN CREDENTIAL is the attack
  { method: "POST", path: "/internal/messages", accepts: "user", shape: "write" },
  { method: "POST", path: "/internal/backfill", accepts: "user", shape: "write" },
  {
    // NOT A `write`, AND THE DIFFERENCE IS THE WHOLE POINT OF HAVING SHAPES. This route
    // takes no body and no path parameter: there is no identifier to forge, so a
    // foreign-identifier attack has nothing to express. Its only tenant-scoped input is
    // the token, which is what `credential` attacks. Classifying it `write` would have
    // produced an attack that sends a valid request and proves nothing.
    method: "POST",
    path: "/internal/session",
    accepts: "user",
    shape: "credential",
  },

  // ── credential, internal, end-user token ─────────────────────────────────────
  //
  // `credential` AND NOT `read`, WHICH IS THE SIBLING ROUTE'S ARGUMENT VERBATIM. The
  // backstop asks what this connection may hear and changes nothing, so `read` is the
  // tempting shape — but a `read` attack forges an IDENTIFIER, and this route takes
  // none: no body, no path parameter, no query. Its only tenant-scoped input is the
  // token, which is exactly what `credential` attacks and what `/internal/session`
  // two entries up was reclassified for.
  //
  // Classifying it `read` would have produced an attack that sends a valid request
  // with nothing forged in it and proves nothing — the failure mode this shape list
  // exists to make visible.
  { method: "GET", path: "/internal/memberships", accepts: "user", shape: "credential" },
];

export function targetKey(t: { method: string; path: string }): string {
  return `${t.method.toUpperCase()} ${t.path}`;
}

/** Counts, for the suite to print. Derived from the list rather than typed beside it,
 * because a hand-maintained tally is the thing that goes stale first. */
export function shapeCounts(list: readonly Classification[]): Record<Shape, number> {
  // THE `list` SHAPE ARRIVED WITH ITS FIRST ROUTE, WHICH IS WHAT THIS SAID WOULD
  // HAPPEN. The note here used to read "no `list` shape yet, and that is deliberate
  // rather than an omission … the chapter that adds the first list route adds the
  // shape and the attack together." `GET /v1/users/:externalId/channels` is that
  // route, and `listAttack` is that attack.
  //
  // AND THE TYPE IS WHY IT COULD NOT ARRIVE HALFWAY. `Record<Shape, number>` stopped
  // compiling the moment `Shape` gained a member, naming this line — so a shape
  // cannot be added to the vocabulary while the tally, and therefore the suite's own
  // report, still counts four kinds. A hand-maintained tally would have printed
  // four and been believed.
  const counts: Record<Shape, number> = {
    read: 0,
    write: 0,
    credential: 0,
    list: 0,
    exempt: 0,
  };
  for (const c of list) counts[c.shape]++;
  return counts;
}

/** One routable endpoint, as the running application reports it. */
export interface DerivedTarget {
  method: string;
  path: string;
}

/** The shape of the express router this reaches into. Declared rather than imported:
 * express 5 ships no types, and adding `@types/express` for one property read would
 * move the api's dependency list for a test's benefit. */
interface RouterLike {
  stack?: Array<{
    route?: { path?: string; methods?: Record<string, boolean> };
    name?: string;
  }>;
}
interface AdapterInstance {
  router?: RouterLike;
  _router?: RouterLike;
}

/** Where the router lives, and the fact that this is not public API.
 *
 * Express 5 exposes `router`; express 4 called it `_router`. Both are read, and WHICH
 * ONE ANSWERED is returned so a test can assert the derivation found something rather
 * than silently finding nothing. That is the failure mode worth designing against: a
 * renamed property would leave this suite green while it attacked zero routes, which is
 * worse than the hand-written list it replaces. */
export function deriveTargets(instance: unknown): {
  targets: DerivedTarget[];
  middlewareLayers: number;
  property: "router" | "_router" | "none";
} {
  const adapter = instance as AdapterInstance;
  const router = adapter.router ?? adapter._router;
  const property = adapter.router ? "router" : adapter._router ? "_router" : "none";
  const targets: DerivedTarget[] = [];
  let middlewareLayers = 0;
  for (const layer of router?.stack ?? []) {
    if (!layer.route) {
      middlewareLayers++;
      continue;
    }
    const path = layer.route.path ?? "";
    for (const [verb, on] of Object.entries(layer.route.methods ?? {})) {
      if (on) targets.push({ method: verb.toUpperCase(), path });
    }
  }
  return { targets, middlewareLayers, property };
}

/** A route that has existed since chapter 2.2 and will exist for as long as this
 * product does. If the derivation cannot find THIS, it has not found the mounted
 * router, whatever else it returned. */
export const CANARY_TARGET = "POST /v1/channels/:channelId/messages";
