import { describe, expect, it, vi, afterEach } from "vitest";

import { createApiClient } from "./api-client.js";

// The one call the gateway makes for itself.
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
    // api to refuse (constitution III).
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

// ── THE TWO RESPONSES THE GATEWAY PARSES, AND WHY A STRICT ONE LOSES A MESSAGE ──────
//
// Both of these read a payload the **api** produced, over a boundary the two services
// deploy independently, and neither reads an attachment: the send response is forwarded
// to the sender as an ack and the backfill page is written straight to a socket. A reader
// that refuses an arm its writer may produce is therefore refusing over a field it
// ignores, and the refusal is not cheap in either case.
//
// THE ARM IS AN UNKNOWN ONE, NOT THE MEDIA ARM. The tasks were written when the media arm
// refused, and a media attachment discriminated strict from permissive then. This chapter
// made it accept, so a media attachment now parses under both and a test using one would
// assert nothing. The case a forwarding reader exists for is an arm from a NEWER writer.
describe("the gateway parses what the api sends it, including an arm it does not know", () => {
  const ID = "3f7c1a2e-0b5d-4c8a-9e61-7a0d2b4f6c81";
  const FUTURE = { type: "audio_clip", clip_id: ID, duration_ms: 1200 };
  const IDENTITY = { userId: "u_1", environmentId: "e_1", token: "t" } as never;

  const message = (attachments: unknown[]) => ({
    id: ID,
    channel: "c_1",
    seq: 1,
    user: "tuan",
    text: "look",
    attachments,
    created_at: new Date().toISOString(),
  });

  // WHAT A REFUSAL COSTS: `internalSendResponseSchema`'s own comment says it — *"every
  // socket send would close 1011."* The message is already committed by then, so the
  // client loses its acknowledgement and its connection, and an idempotent retry fails
  // identically because the api commits again and answers the same shape.
  it("parses a send response carrying an unknown arm (FR-018b, SC-002c)", async () => {
    // `channel_id`, NOT `channel`. The send RESPONSE is the internal contract and the
    // backfill page carries wire FRAMES — two shapes for one message, and the first
    // version of this test used the frame's spelling for both. The strict object caught
    // it: *"send returned a payload the contract does not allow."* That is the half of
    // this design that is supposed to stay loud, so the test was wrong and the schema
    // was right.
    const wire = message([{ type: "media", media_id: ID }, FUTURE]);
    captureFetch({
      id: wire.id,
      channel_id: "c_1",
      seq: wire.seq,
      user: wire.user,
      text: wire.text,
      attachments: wire.attachments,
      created_at: wire.created_at,
      duplicate: false,
    });
    const client = createApiClient("http://api.test", CREDENTIAL);
    const committed = await client.sendMessage(IDENTITY, {
      channel_id: "c_1",
      text: "look",
    } as never);
    expect(committed.attachments).toHaveLength(2);
    expect(committed.attachments[1]).toEqual(FUTURE);
  });

  // WHAT A REFUSAL COSTS HERE: `parse` throws, `session.ts` catches it and answers
  // `degrade("backfill_failed")`. No data is lost — the client re-pages history over REST
  // — but the resume is, for every client whose cursor precedes the media message, for as
  // long as it sits in the window.
  it("parses a backfill page carrying an unknown arm (FR-018d, SC-002e)", async () => {
    captureFetch({
      channels: { c_1: { messages: [message([FUTURE])], truncated: false } },
    });
    const client = createApiClient("http://api.test", CREDENTIAL);
    const channels = await client.backfill(IDENTITY, { c_1: 0 });
    expect(channels.c_1?.messages).toHaveLength(1);
    expect(channels.c_1?.messages[0]?.attachments[0]).toEqual(FUTURE);
  });
});
