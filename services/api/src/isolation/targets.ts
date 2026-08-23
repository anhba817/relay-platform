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
