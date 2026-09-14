import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { publishRequest, toRequestEvent, type RequestFacts } from "./event";

const facts: RequestFacts = {
  requestId: "55555555-5555-4555-8555-555555555555",
  at: new Date("2026-09-14T10:00:00.500Z"),
  method: "POST",
  status: 201,
  latencyMs: 18.25,
  endpoint: "/v1/channels/:channelId/messages",
  environmentId: "11111111-1111-4111-8111-111111111111",
  principalKind: "application",
  refusedAt: "handler",
};

describe("toRequestEvent carries identifiers, statuses and durations only", () => {
  it("emits exactly the contract's fields", () => {
    expect(toRequestEvent(facts)).toEqual({
      type: "api.request",
      request_id: "55555555-5555-4555-8555-555555555555",
      ts: "2026-09-14T10:00:00.500Z",
      method: "POST",
      status: 201,
      latency_ms: 18.25,
      principal_kind: "application",
      refused_at: "handler",
      endpoint: "/v1/channels/:channelId/messages",
      environment_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  // THE ALLOW-LIST IS THE ASSERTION. A spread would carry whatever a future caller attached
  // to the facts -- a body, a header, a decrypted credential -- onto a stream with seven-day
  // retention. An allow-list fails closed when somebody adds a field; a spread fails open.
  it("drops anything it was not asked for", () => {
    const smuggled = {
      ...facts,
      body: { text: "a message somebody wrote" },
      authorization: "Bearer sk_live_deadbeef",
      headers: { cookie: "session=abc" },
    } as unknown as RequestFacts;
    const event = toRequestEvent(smuggled) as unknown as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual([
      "endpoint",
      "environment_id",
      "latency_ms",
      "method",
      "principal_kind",
      "refused_at",
      "request_id",
      "status",
      "ts",
      "type",
    ]);
    expect(JSON.stringify(event)).not.toContain("sk_live_deadbeef");
    expect(JSON.stringify(event)).not.toContain("somebody wrote");
    expect(JSON.stringify(event)).not.toContain("session=abc");
  });

  // ABSENT IS NOT EMPTY. `exactOptionalPropertyTypes` is on, and the column is
  // `LowCardinality(Nullable(String))` because '' and absent are different claims: a 404
  // matched nothing, and a route named "" does not exist.
  it("omits endpoint rather than sending an empty string", () => {
    const noRoute: RequestFacts = { ...facts };
    delete noRoute.endpoint;
    const event = toRequestEvent(noRoute) as unknown as Record<string, unknown>;
    expect("endpoint" in event).toBe(false);
  });

  it("omits environment_id rather than inventing a tenant", () => {
    const tenantless: RequestFacts = { ...facts };
    delete tenantless.environmentId;
    const event = toRequestEvent(tenantless) as unknown as Record<string, unknown>;
    expect("environment_id" in event).toBe(false);
    expect(JSON.stringify(event)).not.toContain("00000000-0000-0000-0000-000000000000");
  });

  it("includes limited_operation only when the limiter refused", () => {
    expect(toRequestEvent(facts)).not.toHaveProperty("limited_operation");
    expect(toRequestEvent({ ...facts, limitedOperation: "send" })).toHaveProperty(
      "limited_operation",
      "send",
    );
  });
});

describe("publishRequest never throws and never logs a payload", () => {
  it("publishes a tenant record on that tenant's subject, keyed on the request id", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    await publishRequest({ publish, close: vi.fn() }, { log: vi.fn() }, facts);
    expect(publish).toHaveBeenCalledWith({
      subject: `analytics.api.request.${facts.environmentId!}`,
      id: facts.requestId,
      payload: toRequestEvent(facts),
    });
  });

  it("publishes a tenantless record on the _none arm", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const tenantless: RequestFacts = { ...facts };
    delete tenantless.environmentId;
    await publishRequest({ publish, close: vi.fn() }, { log: vi.fn() }, tenantless);
    expect(publish.mock.calls[0]![0].subject).toBe("analytics.api.request._none");
  });

  it("swallows a broker failure and logs once, with no payload", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("broker down"));
    const log = vi.fn();
    await expect(
      publishRequest({ publish, close: vi.fn() }, { log }, facts),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    const [level, message, fields] = log.mock.calls[0]!;
    expect(level).toBe("error");
    expect(message).toBe("request_log.publish_failed");
    expect(Object.keys(fields as object).sort()).toEqual(["error", "request_id"]);
  });
});

// ---------------------------------------------------------------------------
// FR-005b2 — the inference from silence, guarded.
//
// `refused_at` reads `handler` when nothing stamped, so a guard that refuses WITHOUT
// stamping is recorded as a plausible wrong value in a column nothing would flag. That is
// the fence-chain checker's shape: the answer meaning "clean" and the answer meaning "never
// looked" printed the same line.
//
// A behavioural test cannot catch a guard that does not exist yet. A structural one can, and
// this codebase has the precedent -- signup's invariant was replaced by the structural claim
// its own comment made and nothing was checking.
// ---------------------------------------------------------------------------
describe("every guard in this api stamps refused_at", () => {
  const src = (p: string): string => readFileSync(join(__dirname, "..", p), "utf8");

  it("credential.guard.ts sets REFUSED_AT before it throws", () => {
    const guard = src("auth/credential.guard.ts");
    expect(guard).toContain("REFUSED_AT");
    // before the first refusal, not after it
    expect(guard.indexOf("REFUSED_AT] = \"guard\"")).toBeLessThan(guard.indexOf("throw new"));
  });

  // ASK THE TREE, DO NOT RESTATE IT. A list of guards written here is a list that goes stale
  // the day somebody adds one, and the test would keep passing -- which is the failure this
  // whole describe block exists to prevent, reproduced inside its own assertion.
  it("finds every guard by scanning, and each one stamps", () => {
    const root = join(__dirname, "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith(".ts") && !e.name.includes(".test.") && !e.name.includes(".itest.")
            ? [join(dir, e.name)]
            : [],
      );
    const guards = walk(root).filter((f) =>
      readFileSync(f, "utf8").includes("implements CanActivate"),
    );
    expect(guards.length).toBeGreaterThan(0); // the probe looked
    for (const g of guards) {
      expect(readFileSync(g, "utf8"), `${g} refuses without stamping refused_at`).toContain(
        "REFUSED_AT",
      );
    }
  });
});
