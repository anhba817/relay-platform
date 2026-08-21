import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Frame } from "@relay/protocol";

import { boot, type Client, type System } from "./harness.js";

// Chapter 3.10 — the cap through the OTHER door, and what it leaves alone.
//
// Chapter 3.8's limiter never sees `/internal/messages`: `operationsFor` returns
// [] for anything outside `/v1`, and that is the route the gateway posts a
// WebSocket send to. This chapter's enforcement point is `sendMessage`, which
// both doors reach — and this is the test that proves it rather than the research
// note that predicted it (research R3).
//
// This lane and not the gateway's, because the refusal has to come from a real
// api child and the gateway's own lane does not spawn one.

describe("a quota through the socket", () => {
  let system: System;
  let environmentId: string;
  let channel: string;
  let dispatcher: Client;

  beforeAll(async () => {
    system = await boot({ gateways: 1 });
    const seeded = await system.seedConversation();
    ({ environmentId, channel, dispatcher } = seeded);
    await dispatcher.connect(system.gateways[0]!);
  }, 120_000);

  afterAll(async () => {
    await system?.stop();
  });

  it("refuses the send and leaves the socket open", async () => {
    // One message through, then the cap set at what has already been used.
    dispatcher.send(channel, "before the cap");
    await dispatcher.waitFor(
      (f: Frame) => f.type === "message.created",
      "the first message to land",
    );

    await system.setQuota(environmentId, { messages: { hard: 1 } });

    const before = dispatcher.frames.length;
    dispatcher.send(channel, "after the cap");

    // The socket does not carry the 402 — the gateway holds the connection and
    // the api refuses the POST behind it. What matters here is the negative: no
    // `message.created` for the refused send, and the connection still up.
    await new Promise((r) => setTimeout(r, 2_000));
    const created = dispatcher.frames
      .slice(before)
      .filter((f: Frame) => f.type === "message.created");
    expect(created).toHaveLength(0);

    // SC-003 — STILL OPEN, AND STILL RECEIVING. A cap that closed the socket
    // would be an outage dressed as a business control, and FR-RTL-08 exists to
    // say it is not one.
    await system.setQuota(environmentId, {});
    dispatcher.send(channel, "after the cap was lifted");
    await dispatcher.waitFor(
      (f: Frame) =>
        f.type === "message.created" &&
        JSON.stringify(f).includes("after the cap was lifted"),
      "the socket to still be carrying messages",
    );
  }, 120_000);
});
