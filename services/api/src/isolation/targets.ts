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
export type Shape = "read" | "write" | "credential" | "exempt";

/** Which credential class the route accepts, and therefore which attack applies.
 *
 * A `write` shape alone cannot tell these apart. A route taking an end-user token is
 * already scoped to one environment, so the attack is a FOREIGN CREDENTIAL. A route
 * taking an application key is scoped too, but by a different resolution — and a route
 * that accepts either is attacked as both, which is why `either` is a class rather
 * than a shrug. */
export type CredentialClass = "application" | "user" | "either" | "none";

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
];

export function targetKey(t: { method: string; path: string }): string {
  return `${t.method.toUpperCase()} ${t.path}`;
}

/** Counts, for the suite to print. Derived from the list rather than typed beside it,
 * because a hand-maintained tally is the thing that goes stale first. */
export function shapeCounts(list: readonly Classification[]): Record<Shape, number> {
  // NO `list` SHAPE YET, and that is deliberate rather than an omission. Nothing this
  // api serves returns a collection, so a list attack would be a function with no
  // target — and a shape with no member is a vocabulary entry that drifts. The chapter
  // that adds the first list route adds the shape and the attack together.
  const counts: Record<Shape, number> = { read: 0, write: 0, credential: 0, exempt: 0 };
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
