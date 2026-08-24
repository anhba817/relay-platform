/** The gauntlet's target list (chapter 3.12, NFR-SEC-09).
 *
 * A LIST OF CLASSIFICATIONS, NOT A LIST OF TARGETS. The targets themselves are
 * derived from the running application — `app.getHttpAdapter().getInstance().router.stack`
 * — because the fault this suite exists to prevent is a route that exists and is
 * unattacked, and only the router knows what exists. What lives here is the
 * decision about each one, which no derivation can make.
 *
 * NOTHING MAY BE EXEMPT BY OMISSION. A derived target matching no entry fails the
 * suite, and an entry matching no derived target fails it too — the second
 * direction is the one that catches a stale exemption after a rename. That pair of
 * assertions is the whole mechanism; feature 030's doctrine is that whatever
 * silently absorbs the next case is the thing to remove. */

/** What kind of attack a route takes.
 *
 * `credential` is the shape the specification did not anticipate.
 * `POST /auth/dev-token` accepts no tenant-owned identifier, so a foreign-id attack
 * has nothing to put in it — and it is tenant-scoped all the same, because the key
 * it accepts resolves to exactly one environment. Filing it as `exempt` is how a
 * route stops being attacked while looking accounted for (research R4). */
export type Shape = "read" | "list" | "write" | "credential" | "exempt";

/** Which credential class the route accepts, and therefore which attack applies.
 *
 * NOT IN `data-model.md` §2, and added here because T031 and T031a need it. The
 * internal surface is two credential classes: three routes take an end-user token,
 * which IS scoped to one environment, so a foreign credential is the attack; five
 * take a platform credential, which carries no environment, so the attack is a
 * request naming one environment with an identifier from another. A `write` shape
 * alone cannot tell those apart, and an earlier draft of this chapter gave all
 * eight the platform attack (research R5). */
export type CredentialClass = "application" | "user" | "platform" | "none";

interface Classified {
  method: string;
  path: string;
  accepts: CredentialClass;
}

export type Classification =
  | (Classified & { shape: Exclude<Shape, "exempt">; because?: string })
  | (Classified & { shape: "exempt"; because: string });

/** Every route the api serves, as measured by T008's derivation: 22 today.
 *
 * The five shapes sum to 22 — 3 exempt, 1 credential, 1 list, 2 read, 15 write —
 * and that sum is the check that caught `POST /v1/webhooks` missing from an earlier
 * draft of `data-model.md`'s shape table, where five rows accounted for 21. */
export const CLASSIFICATIONS: readonly Classification[] = [
  // ── exempt: no tenant-owned identifier and no tenant-scoped credential ───────
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
      "the OAuth redirect. Its parameter is a provider name, validated against a configured set; there is no tenant yet, which is what signup is for.",
  },
  {
    method: "GET",
    path: "/auth/:provider/callback",
    accepts: "none",
    shape: "exempt",
    because:
      "the OAuth return. Its authority is a state cookie bound to the browser that began the flow, and chapter 3.1's suite already attacks that binding directly.",
  },

  // ── credential: tenant-scoped without taking an identifier ──────────────────
  {
    method: "POST",
    path: "/auth/dev-token",
    accepts: "application",
    shape: "credential",
    because:
      "no identifier to forge, so the attack is on the credential: a key for one environment must not mint a token that works in another.",
  },

  // ── list ────────────────────────────────────────────────────────────────────
  { method: "GET", path: "/v1/webhooks", accepts: "application", shape: "list" },

  // ── read ────────────────────────────────────────────────────────────────────
  { method: "GET", path: "/v1/webhooks/:id", accepts: "application", shape: "read" },
  {
    method: "GET",
    path: "/v1/channels/:channelId/messages",
    accepts: "application",
    shape: "read",
  },

  // ── write, public ───────────────────────────────────────────────────────────
  { method: "POST", path: "/v1/channels/:channelId/messages", accepts: "application", shape: "write" },
  // Chapter 3.12's two new routes, and the order they were added in is the point.
  // The derivation found them first: `targets.itest.ts` went from 22 to 24 and
  // named them as unclassified, on the build that registered the module and
  // before anything here mentioned them. That is the failure the derivation
  // exists to produce (FR-021), and the classification is what changed in answer
  // to it — never the derivation.
  { method: "POST", path: "/v1/channels", accepts: "application", shape: "write" },
  { method: "POST", path: "/v1/channels/:channelId/members", accepts: "application", shape: "write" },
  // Chapter 3.15's two, and the derivation found them the same way it found the
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
  { method: "POST", path: "/v1/webhooks", accepts: "application", shape: "write" },
  { method: "POST", path: "/v1/webhooks/:id/rotate-secret", accepts: "application", shape: "write" },
  { method: "POST", path: "/v1/webhooks/:id/enable", accepts: "application", shape: "write" },
  { method: "POST", path: "/v1/webhooks/:id/disable", accepts: "application", shape: "write" },
  { method: "POST", path: "/v1/webhooks/:id/test", accepts: "application", shape: "write" },
  { method: "DELETE", path: "/v1/webhooks/:id", accepts: "application", shape: "write" },

  // ── write, internal, end-user token: scoped to one environment ──────────────
  { method: "POST", path: "/internal/messages", accepts: "user", shape: "write" },
  { method: "POST", path: "/internal/session", accepts: "user", shape: "write" },
  { method: "POST", path: "/internal/backfill", accepts: "user", shape: "write" },

  // ── write, internal, platform credential: carries no environment ────────────
  { method: "POST", path: "/internal/usage/connections", accepts: "platform", shape: "write" },
  { method: "POST", path: "/internal/dispatch/expand", accepts: "platform", shape: "write" },
  { method: "POST", path: "/internal/dispatch/material", accepts: "platform", shape: "write" },
  { method: "POST", path: "/internal/dispatch/outcome", accepts: "platform", shape: "write" },
  { method: "POST", path: "/internal/dispatch/replay", accepts: "platform", shape: "write" },
];

/** The key a derived route and a classification are joined on. */
export function targetKey(t: { method: string; path: string }): string {
  return `${t.method.toUpperCase()} ${t.path}`;
}

/** Counts, for the suite to print and `baseline.txt` to record. Derived from the
 * list rather than typed beside it, because a hand-maintained tally is the thing
 * that goes stale first. */
export function shapeCounts(): Record<Shape, number> {
  const counts: Record<Shape, number> = { read: 0, list: 0, write: 0, credential: 0, exempt: 0 };
  for (const c of CLASSIFICATIONS) counts[c.shape]++;
  return counts;
}

/** One routable endpoint, as the running application reports it. */
export interface DerivedTarget {
  method: string;
  path: string;
}

/** The shape of the express router this reaches into. Declared rather than
 * imported: express 5 ships no types, and adding `@types/express` for one
 * property read would move the api's dependency list for a test's benefit. */
interface RouterLike {
  stack?: Array<{ route?: { path?: string; methods?: Record<string, boolean> }; name?: string }>;
}
interface AdapterInstance {
  router?: RouterLike;
  _router?: RouterLike;
}

/** Where the router lives, and the fact that this is not public API.
 *
 * Express 5 exposes `router`; express 4 called it `_router`. Both are read, and
 * which one answered is returned so a test can assert the derivation found
 * something rather than silently finding nothing — the failure mode that would
 * make this whole suite pass while attacking zero routes (research R2). */
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
