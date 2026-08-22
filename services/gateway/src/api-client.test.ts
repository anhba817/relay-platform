import { describe, expect, it, vi, afterEach } from "vitest";

import { createApiClient } from "./api-client.js";

// The one call the gateway makes for itself (chapter 3.11).
//
// `api-client.itest.ts` does not exist and does not need to: what these tests
// assert is not what the api answers, it is what the GATEWAY sends — and the
// single most important thing about a usage report is the credential it does
// NOT carry.

const CREDENTIAL = "rk_svc_gateway_unit_0123456789abcdef0123";
const REPORT = {
  connections: [
    {
      connection_id: "0f9c8b7a-6d5e-4c3b-8a19-8f7e6d5c4b3a",
      environment_id: "8b21c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      period: "2026-08-01",
      minutes: 17,
    },
  ],
};

function captureFetch(response: unknown = { credited: 17 }, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const stub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reportUsage carries the gateway's own credential", () => {
  it("presents the service credential, and no user token", async () => {
    // THE WHOLE OF RESEARCH R1 IS THIS ASSERTION. An implementation that reached
    // for a connection's token would pass every other test in this chapter: the
    // report would be accepted, the minutes credited, the figures right — until
    // a long-lived socket's token expired, which is the socket with the most
    // minutes on it.
    const calls = captureFetch();
    const api = createApiClient("http://api.test", CREDENTIAL);
    await api.reportUsage(REPORT);

    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${CREDENTIAL}`);
    expect(headers["authorization"]).not.toMatch(/^Bearer ey/); // not a JWT
  });

  it("posts to the platform route with the report as its body", async () => {
    const calls = captureFetch();
    await createApiClient("http://api.test", CREDENTIAL).reportUsage(REPORT);

    expect(calls[0]!.url).toBe("http://api.test/internal/usage/connections");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(REPORT);
  });

  it("sends NOTHING when no credential is configured", async () => {
    // A gateway with no metering credential serves sockets. It does not throw,
    // it does not retry, and it does not send an unauthenticated report for the
    // api to refuse (FR-012).
    const calls = captureFetch();
    const api = createApiClient("http://api.test");

    expect(await api.reportUsage(REPORT)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("parses the answer rather than trusting it", async () => {
    // Same rule as every other call in this file: an internal caller has no more
    // right to trust a payload's shape than an external one does.
    captureFetch({ credited: "seventeen" });
    await expect(
      createApiClient("http://api.test", CREDENTIAL).reportUsage(REPORT),
    ).rejects.toThrow(/contract does not allow/);
  });

  it("throws with the status when the api refuses", async () => {
    captureFetch({ code: "wrong_credential_type" }, 403);
    await expect(
      createApiClient("http://api.test", CREDENTIAL).reportUsage(REPORT),
    ).rejects.toThrow(/403/);
  });
});
